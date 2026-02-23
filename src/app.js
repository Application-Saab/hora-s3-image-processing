const express = require("express");
const cors = require("cors");
const processDriveRoutes = require("./routes/processDrive.routes");
require('dotenv').config(); // <- top par add karo

const app = express();
app.use(express.json());
app.use(cors());

app.use(express.json()); // for JSON
app.use(express.urlencoded({ extended: true })); // for form data


// Routes
app.use("/test", (req, res) => {
  res.json({ message: "Test route working !!!" });
});
app.use("/", processDriveRoutes);

module.exports = app;
