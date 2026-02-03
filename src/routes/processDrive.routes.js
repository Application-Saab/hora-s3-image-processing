const express = require("express");
const router = express.Router();
const { handleDriveFolderUpload , uploadSingleImage} = require("../services/drive.service");
const Folder = require("../models/folder");
const fs = require("fs");
const { uploadFileToS3, generateThumbnail ,upload} = require("../utils/auth.util");
const multer = require("multer");
const path = require("path");
const WebLink = require("../models/weblink-images")
const fsPromises = require("fs").promises;
const AWS = require("aws-sdk");


const s3 = new AWS.S3({
  accessKeyId: process.env.AWS_ACCESS_KEY_ID,
  secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  region: process.env.AWS_REGION,
});
const uploadSingel = multer({ dest: "tempUploads/" });

const TEMP_DIR = path.join(process.cwd(), "tempUploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });



router.get("/health", (req, res) => {
  res.json({ status: "OK" });
});

/**
 * DELETE /delete-image/:id
 * Deletes image by WebLink ID from MongoDB and S3
 */
router.delete("/delete-image/:id", async (req, res) => {
  const { id } = req.params;

  try {
    // Find the image in MongoDB
    const image = await WebLink.findById(id);
    if (!image) {
      return res.status(404).json({ message: "Image not found" });
    }

    // Build list of S3 keys to delete
    const keysToDelete = [];

    if (image.originalKey) keysToDelete.push({ Key: image.originalKey });
    if (image.thumbnailKey) keysToDelete.push({ Key: image.thumbnailKey });
    if (image.videoClipKey) keysToDelete.push({ Key: image.videoClipKey });

    if (keysToDelete.length > 0) {
      await s3
        .deleteObjects({
          Bucket: process.env.S3_BUCKET_NAME,
          Delete: { Objects: keysToDelete },
        })
        .promise();
    }

    // Delete document from MongoDB
    await WebLink.findByIdAndDelete(id);

    res.json({ message: "Image deleted successfully" });
  } catch (err) {
    console.error("Delete failed:", err);
    res.status(500).json({ message: "Server error", error: err.message });
  }
});

router.post("/process-drive", async (req, res) => {
  const { folderUrl, order_id, phoneNo, customerId, mainFolderId} = req.body;
console.log('main folder id in the process drive',mainFolderId);
  if (!folderUrl || !order_id) {
    return res.status(400).json({ message: "folderUrl & order_id required" });
  }
  // frontend ko turant response
  res.json({ message: "Processing started" });

  setImmediate(async () => {
    try {
      const vendorId = order_id + 10800;
      await handleDriveFolderUpload(folderUrl, vendorId,phoneNo,customerId,order_id, mainFolderId);
      console.log("Drive processing completed:", vendorId);
    } catch (err) {
      console.error("Drive processing failed:", err.message);
    }
  });
});

router.post(
  "/create-subfolder",
  uploadSingel.single("file"),
  async (req, res) => {
    try {
      const {
        folderName,
        type,
        userId,
        subFolderName,
        customerId,
        vendorId,
        phoneNo,
      } = req.body;

      if (!folderName || !type || !userId) {
        return res.status(400).json({
          message: "folderName, type and userId are required",
        });
      }

      const folder = await Folder.findOne({ folderName });

      if (!folder) {
        return res.status(404).json({
          message: "Main folder does not exist",
        });
      }

      if (type === "my_photos") {
        const alreadyExists = folder.subFolders.some(
          (sf) => sf.userId === userId && sf.type === "my_photos"
        );

        if (alreadyExists) {
          return res.status(409).json({
            message: "My Photos subfolder already exists",
          });
        }
      }

      let folderDp = "";

      // 🔥 REUSE upload-single logic
      if (req.file) {
        folderDp = await uploadSingleImage({
          file: req.file,
          folderName,
          customerId,
          vendorId,
          phoneNo,
        });
      }

      const newSubFolder = {
        folderName: type === "my_photos" ? "My Photos" : subFolderName,
        type,
        userId: type === "my_photos" ? userId : folder.customerId,
        folderDp,
      };

      folder.subFolders.push(newSubFolder);
      await folder.save();
      const savedSubFolder = folder.subFolders[folder.subFolders.length - 1];


      res.status(201).json({
        message: "Subfolder created successfully",
        subFolder: savedSubFolder,
      });
    } catch (error) {
      console.error("Create subfolder error:", error);
      res.status(500).json({
        message: "Server error",
        error: error.message,
      });
    }
  }
);



router.post("/upload-single", uploadSingel.single("file"), async (req, res) => {
  try {
    const { folderName, customerId, vendorId, phoneNo } = req.body;

    if (!folderName || !customerId) {
      return res
        .status(400)
        .json({ message: "Folder Name and Customer ID are required." });
    }

    if (!req.file) {
      return res.status(400).json({ message: "No file was uploaded." });
    }

    // Construct folder path for S3
    const folderPath = vendorId
      ? `${folderName}_${customerId}_${vendorId}`
      : `${folderName}_${customerId}`;

    const file = req.file;
    const filePath = file.path;
    const fileName = file.filename;

    console.log(
      `Processing file: ${file.originalname} at ${new Date().toLocaleTimeString()}`
    );

    // Generate thumbnail path
    const thumbnailPath = `${filePath.replace(/\.(png|jpeg|jpg)$/i, "")}_thumbnail.webp`;

    // Generate thumbnail
    await generateThumbnail(filePath, thumbnailPath);

    // Upload original file to S3
    const s3Response = await uploadFileToS3(filePath, fileName, folderPath, phoneNo);

    // Upload thumbnail to S3
    const thumbFileName = `thumb_${fileName.replace(/\.(png|jpeg|jpg)$/i, "")}.webp`;
    const s3ThumbResponse = await uploadFileToS3(thumbnailPath, thumbFileName, folderPath, phoneNo);

    // Delete local temp files
    fs.unlinkSync(filePath);
    fs.unlinkSync(thumbnailPath);

    res.status(201).json({
      message: "File uploaded successfully.",
      file: {
        fileName: file.originalname,
        fileUrl: s3Response.Location,
        s3Key: s3Response.Key,
        thumbnailUrl: s3ThumbResponse.Location,
        thumbnailKey: s3ThumbResponse.Key,
      },
    });
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Server error", error: error.message });
  }
});


router.post("/upload-multiple", upload.array("images", 10), async (req, res) => {
  try {
    const { orderId, customerId, phoneNo, name, folderName } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No images uploaded" });
    }

     const folder = await Folder.findOne({ folderName }).lean();

    let finalOrderId = orderId;
    if (!finalOrderId && folderName) {
      finalOrderId = folderName.split("_")[0];
    }

    if (!finalOrderId || !customerId) {
      return res
        .status(400)
        .json({ message: "orderId and customerId are required" });
    }

    const folderPath = `orders/${finalOrderId}_${customerId}`;

    const results = [];

    for (const file of files) {
      let thumbPath;
      try {
        const originalPath = file.path;
        const thumbName = `thumb_${file.filename}.webp`;
        thumbPath = path.join(TEMP_DIR, thumbName);

        await generateThumbnail(originalPath, thumbPath);

        const originalRes = await uploadFileToS3(
          originalPath,
          file.filename,
          folderPath,
          phoneNo,
          file.mimetype
        );

        const thumbRes = await uploadFileToS3(
          thumbPath,
          thumbName,
          folderPath,
          phoneNo,
          "image/webp"
        );
        console.log(phoneNo);

        const saved = await WebLink.create({
          orderId: finalOrderId.toString(),
          orderById: customerId,
          mainFolderId:folder._id,
          orderByName: phoneNo || "",
          type: "image",
          originalUrl: originalRes.Location,
          originalKey: originalRes.Key,
          thumbnailImageUrl: thumbRes.Location,
          thumbnailKey: thumbRes.Key,
        });

        results.push({
          fileName: file.originalname,
          imageId: saved._id,
          imageUrl: originalRes.Location,
          thumbnailUrl: thumbRes.Location,
          orderById:saved.orderById,
          orderByName:saved.orderByName,
          mainFolderId:saved.mainFolderId,
        });

        // cleanup
        [originalPath, thumbPath].forEach((p) => {
          if (p && fs.existsSync(p)) fs.unlinkSync(p);
        });
      } catch (err) {
        console.error(`Image failed: ${file.originalname}`, err.message);
        results.push({
          fileName: file.originalname,
          error: err.message,
        });
      }
    }

    return res.status(200).json({
      success: true,
      total: results.length,
      images: results,
    });
  } catch (err) {
    console.error("Bulk upload error:", err.message);
    return res.status(500).json({ message: err.message });
  }
});


module.exports = router;




