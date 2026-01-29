const express = require("express");
const processDriveRoutes = require("./routes/processDrive.routes");

const app = express();
app.use(express.json());

// Routes
app.use("/", processDriveRoutes);

module.exports = app;
