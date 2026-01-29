const express = require("express");
const router = express.Router();
const { handleDriveFolderUpload } = require("../services/drive.service");

router.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

router.post("/process-drive", async (req, res) => {
  const { folderUrl, order_id, phoneNo, customerId } = req.body;

  if (!folderUrl || !order_id) {
    return res.status(400).json({ message: "folderUrl & order_id required" });
  }
  // frontend ko turant response
  res.json({ message: "Processing started" });

  setImmediate(async () => {
    try {
      const vendorId = order_id + 10800;
      await handleDriveFolderUpload(folderUrl, vendorId,phoneNo,customerId);
      console.log("Drive processing completed:", vendorId);
    } catch (err) {
      console.error("Drive processing failed:", err.message);
    }
  });
});

module.exports = router;
