# AWS EC2 CI/CD Demo

A small learning project: a containerized Node.js app that is built, tested, pushed to Amazon ECR, and deployed to an EC2 instance automatically on every push to `main`, using GitHub Actions with passwordless (OIDC) authentication and AWS Systems Manager. No SSH is needed for deployments and no AWS keys are stored in GitHub.

## Architecture

```
Developer ──git push──▶ GitHub (main)
                           │
                           ▼
                  GitHub Actions workflow
                  ┌──────────────────────────────────┐
                  │ 1. build-and-test                │
                  │    build image, run it,          │
                  │    check /health                 │
                  │ 2. push-image                    │
                  │    OIDC ─▶ IAM role ─▶ ECR      │
                  │    tag = first 7 chars of commit │
                  │ 3. deploy                        │
                  │    OIDC ─▶ IAM role ─▶ SSM      │
                  └──────────────────────────────────┘
                           │ SSM Run Command
                           ▼
        EC2 (Ubuntu, Docker, SSM agent, IAM instance role)
          deploy.sh <tag>: pull from ECR ─▶ run ─▶ health check
                           └─ unhealthy? roll back to the previous image
```

## AWS services used

| Service | Purpose |

| EC2 | Runs the Docker container (Ubuntu, free-tier instance) |
| ECR | Private registry for the app's Docker images |
| IAM | Instance role (pull from ECR + SSM), GitHub OIDC role (push to ECR + run one SSM command) |
| IAM OIDC provider | Lets GitHub Actions authenticate with short-lived tokens instead of access keys |
| Systems Manager (Run Command) | Runs the deploy script on the instance without opening port 22 |
| AWS Budgets | Cost alert set up before anything else |

Region: `ap-south-1` (Mumbai).

## The app

`server.js` is a tiny Node HTTP server:

- `GET /` returns `Hello from my EC2 app! Version: <version>`
- `GET /health` returns `{"status":"ok"}` with HTTP 200

The `/health` endpoint is what the pipeline and the deploy script use to decide whether a release works.

## CI/CD pipeline

Defined in `.github/workflows/ci-cd.yml`:

| Job | Runs on | What it does |

| `build-and-test` | Every push and pull request | Builds the image, starts it, and checks `/health` |
| `push-image` | Push to `main` only, after tests pass | Assumes the AWS role via OIDC, builds the image, pushes it to ECR tagged with the short commit SHA |
| `deploy` | Push to `main` only, after the push | Assumes the AWS role via OIDC and uses SSM Run Command to execute `deploy.sh <tag>` on the instance |

Pull requests only run the tests; they never push or deploy.

## Deploy script with automatic rollback

`deploy.sh` lives on the server at `/home/ubuntu/deploy.sh`. It:

1. Records which image is currently running
2. Logs in to ECR and pulls the new tag
3. Replaces the running container
4. Polls `/health` for up to ~20 seconds
5. If the check never passes, removes the new container, restarts the previous image, and exits with an error so the pipeline job fails

This was tested by deliberately deploying a broken version (`/health` returning HTTP 500) and confirming the previous version kept serving traffic.

<details>
<summary>deploy.sh</summary>

```bash
#!/bin/bash
set -u

REGION=ap-south-1
APP=demo-app
NEW_TAG=${1:?"Usage: ./deploy.sh <tag>"}

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
REGISTRY=$ACCOUNT_ID.dkr.ecr.$REGION.amazonaws.com
NEW_IMAGE=$REGISTRY/$APP:$NEW_TAG

# Remember what is running now, so we can roll back to it
PREVIOUS_IMAGE=$(docker inspect --format '{{.Config.Image}}' $APP 2>/dev/null || true)

echo "Logging in to ECR..."
aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY > /dev/null || exit 1

echo "Pulling $NEW_IMAGE"
docker pull $NEW_IMAGE || { echo "Pull failed, nothing changed."; exit 1; }

echo "Starting new version..."
docker rm -f $APP > /dev/null 2>&1
docker run -d --name $APP -p 80:3000 --restart unless-stopped $NEW_IMAGE > /dev/null

echo "Checking health..."
for i in $(seq 1 10); do
  if curl -fs http://localhost/health > /dev/null; then
    echo "SUCCESS: $NEW_TAG is healthy and live."
    exit 0
  fi
  sleep 2
done

echo "FAILED: $NEW_TAG did not become healthy."
docker rm -f $APP > /dev/null 2>&1
if [ -n "$PREVIOUS_IMAGE" ]; then
  echo "Rolling back to $PREVIOUS_IMAGE"
  docker run -d --name $APP -p 80:3000 --restart unless-stopped $PREVIOUS_IMAGE > /dev/null
else
  echo "No previous version to roll back to."
fi
exit 1
```

</details>

## Security model

- **No long-lived AWS keys in GitHub.** GitHub Actions gets short-lived credentials through OIDC.
- **Trust is scoped.** The GitHub role can only be assumed by this repository's `main` branch.
- **Least privilege.** The GitHub role can push to one ECR repository and send one SSM document to one instance. The instance role can only pull images and register with SSM.
- **No SSH in the pipeline.** Deployments go through SSM, so port 22 is not needed by automation.
- **Secrets stay out of Git.** `.gitignore` excludes `.env` and `*.pem`.

## Setup summary

1. Set up an AWS Budget alert and enable MFA on the root user
2. Launch an Ubuntu EC2 instance (free-tier type), with SSH limited to your own IP and HTTP (80) open
3. Install Docker on the instance
4. Create an ECR repository named `demo-app`
5. Create an IAM role for the instance with `AmazonEC2ContainerRegistryReadOnly` and `AmazonSSMManagedInstanceCore`, and attach it to the instance
6. Create the GitHub OIDC identity provider (`token.actions.githubusercontent.com`, audience `sts.amazonaws.com`)
7. Create an IAM role for GitHub Actions with a trust policy limited to this repo's `main` branch, plus policies for ECR push and SSM `SendCommand`
8. Place `deploy.sh` on the instance at `/home/ubuntu/deploy.sh` and make it executable
9. Set the role ARN and instance ID in the workflow, then push to `main`

Account-specific values (account ID, instance ID, role ARN) are in the workflow file; replace them with your own.

## Troubleshooting notes

Problems hit while building this, and their fixes:

| Problem | Cause | Fix |

| SSH: "UNPROTECTED PRIVATE KEY FILE" on Windows | The `.pem` file was readable by `Authenticated Users` | Remove extra ACL entries with `icacls ... /remove` or keep the key on `C:` |
| AWS CLI: could not connect to `sts.global.amazonaws.com` | Default region was saved as `global` | `aws configure set region ap-south-1` |
| `AccessDenied` on `ecr:CreateRepository` | `AmazonEC2ContainerRegistryPowerUser` allows push and pull but not repo creation | Create the repository in the console |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | The OIDC `sub` claim GitHub sent was `repo:<owner>@<id>/<repo>@<id>:ref:refs/heads/main` (ID-based format), not `repo:<owner>/<repo>:...` | Print the real claims in a debug step and copy the exact `sub` into the trust policy |
| Instance missing from SSM Fleet Manager | Instance role lacked `AmazonSSMManagedInstanceCore` | Attach the policy and restart the SSM agent |
| Docker warning "credentials stored unencrypted" in SSM output | `docker login` as root with no credential helper | Harmless here: the ECR token expires after 12 hours and is read-only |

## What I learned

- How EC2, security groups, key pairs, and instance roles fit together
- Pushing and pulling images with ECR, and tagging images by commit
- Passwordless CI/CD authentication with GitHub OIDC and IAM trust policies
- Using SSM Run Command for deployments without SSH
- Health checks and automatic rollback as a deployment safety net
- Debugging IAM issues by reading the actual claims and agent logs instead of guessing

## Cost and cleanup

Everything runs on the free tier or costs very little. When finished:

1. Terminate the EC2 instance (EC2 > Instances > Instance state > Terminate)
2. Delete the ECR repository (and its images)
3. Delete the IAM roles, the OIDC provider, and the custom policies
4. Delete the access key for the local CLI user
5. Leave the budget alert in place

## Possible next steps

- Define the infrastructure in Terraform instead of console clicks
- Put the instance behind an Application Load Balancer for zero-downtime deploys
- Add HTTPS with a domain and a free certificate
- Add CloudWatch alarms for CPU and failed deployments
