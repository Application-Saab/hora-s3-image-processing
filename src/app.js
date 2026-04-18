const express = require("express");
const cors = require("cors");
const processDriveRoutes = require("./routes/processDrive.routes");
const wonderlandEventRoutes = require("./routes/event.routes");
require("dotenv").config();
let bodyParser = require("body-parser");

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.json()); // for JSON
app.use(bodyParser.json({ limit: "250mb" }));
app.use(
  bodyParser.urlencoded({
    limit: "250mb",
    extended: true,
    parameterLimit: 1000000,
  })
); 

// Routes
app.use("/test", (req, res) => {
  res.json({ message: "Test route working !!!" });
});
app.use("/event", wonderlandEventRoutes);
app.use("/", processDriveRoutes);

module.exports = app;
