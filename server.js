const http = require("http");
const VERSION = process.env.APP_VERSION || "v2";

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ status: "ok" }));
  }
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`Hello from my EC2 app! Version: ${VERSION}\n`);
});

server.listen(3000, () => console.log("Listening on port 3000"));


