name: CI

   on:
     pull_request:
     push:
       branches: [main]

   jobs:
     build-and-test:
       runs-on: ubuntu-latest
       steps:
         - uses: actions/checkout@v4

         - name: Build image
           run: docker build -t demo-app:ci .

         - name: Start container
           run: docker run -d --name test -p 3000:3000 demo-app:ci

         - name: Health check
           run: |
             for i in $(seq 1 10); do
               if curl -fs http://localhost:3000/health; then
                 echo "Healthy"
                 exit 0
               fi
               sleep 2
             done
             docker logs test
             exit 1