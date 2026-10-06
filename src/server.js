require("dotenv").config();
const http = require("http");             
const app = require("./app");
const mongoose = require("mongoose");
const { initSocket } = require(".././socket");  

mongoose.set("strictQuery", true);
mongoose.connect(
  `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@${process.env.MONGO_CLUSTER}/${process.env.MONGO_DATABASE}?retryWrites=true&w=majority`
);

const PORT = process.env.PORT || 4000;

const server = http.createServer(app);
initSocket(server);

server.listen(PORT, () => {                   
  console.log("Media Worker running on port", PORT);
});