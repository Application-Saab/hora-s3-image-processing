require("dotenv").config();
const app = require("./app");
const mongoose = require("mongoose");

mongoose.set("strictQuery", true);
mongoose.connect(
  `mongodb+srv://${process.env.MONGO_USER}:${process.env.MONGO_PASS}@${process.env.MONGO_CLUSTER}/${process.env.MONGO_DATABASE}?retryWrites=true&w=majority`
);

const PORT = process.env.PORT || 4000;

app.listen(PORT, () => {
  console.log("Media Worker running on port", PORT);
});
