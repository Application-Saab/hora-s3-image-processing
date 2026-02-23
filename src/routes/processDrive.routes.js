const express = require("express");
const router = express.Router();
const { handleDriveFolderUpload, uploadSingleImage } = require("../services/drive.service");
const Folder = require("../models/folder");
const fs = require("fs");
const { uploadFileToS3, generateThumbnail, upload, generateVideoPreview } = require("../utils/auth.util");
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
  const { folderUrl, order_id, phoneNo, customerId, mainFolderId } = req.body;
  if (!folderUrl || !order_id) {
    return res.status(400).json({ message: "folderUrl & order_id required" });
  }
  // frontend ko turant response
  res.json({ message: "Processing started" });

  setImmediate(async () => {
    try {
      const vendorId = order_id + 10800;
      await handleDriveFolderUpload(folderUrl, vendorId, phoneNo, customerId, order_id, mainFolderId);
      console.log("Drive processing completed:", vendorId);
    } catch (err) {
      console.error("Drive processing failed:", err.message);
    }
  });
});

router.post("/create-subfolder", uploadSingel.single("file"), async (req, res) => {
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

    // REUSE upload-single logic
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

router.post("/upload-multiple", upload.array("images"), async (req, res) => {
  try {
    const { orderId, customerId, phoneNo, name, folderName } = req.body;
    const files = req.files;

    if (!files || files.length === 0) {
      return res.status(400).json({ message: "No images uploaded" });
    }

    const folder = await Folder.findOne({ folderName }).lean();

    if (!folder) {
      return res.status(404).json({
        message: "Folder not found",
      });
    }

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
      const isImage = file.mimetype.startsWith("image/");
      const isVideo = file.mimetype.startsWith("video/");

      const originalPath = file.path;
      let thumbPath;
      let clipPath;

      try {
        // ================= IMAGE =================
        if (isImage) {
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

          const saved = await WebLink.create({
            orderId: finalOrderId.toString(),
            orderById: customerId,
            mainFolderId: folder._id,
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
          });
        }

        // ================= VIDEO =================
        else if (isVideo) {
          const clipName = `clip_${file.filename}.mp4`;
          clipPath = path.join(TEMP_DIR, clipName);

          await generateVideoPreview(originalPath, clipPath, 3);

          const videoRes = await uploadFileToS3(
            originalPath,
            file.filename,
            folderPath,
            phoneNo,
            file.mimetype
          );

          const clipRes = await uploadFileToS3(
            clipPath,
            clipName,
            folderPath,
            phoneNo,
            "video/mp4"
          );

          const saved = await WebLink.create({
            orderId: finalOrderId.toString(),
            orderById: customerId,
            mainFolderId: folder._id,
            orderByName: phoneNo || "",
            type: "video",
            originalUrl: videoRes.Location,
            originalKey: videoRes.Key,
            thumbnailImageUrl: null,
            thumbnailKey: null,
            videoClipUrl: clipRes.Location,
            videoClipKey: clipRes.Key,
          });

          results.push({
            fileName: file.originalname,
            imageId: saved._id,
            videoUrl: videoRes.Location,
            clipUrl: clipRes.Location,
          });
        }
      } catch (err) {
        console.error(`Processing failed: ${file.originalname}`, err.message);
        results.push({
          fileName: file.originalname,
          error: err.message,
        });
      } finally {
        // 🔥 GUARANTEED CLEANUP
        const paths = [originalPath, thumbPath, clipPath];

        await Promise.all(
          paths.map(async (p) => {
            if (p && fs.existsSync(p)) {
              try {
                await fsPromises.unlink(p);
                console.log("Deleted:", p);
              } catch (err) {
                console.error("Delete failed:", p, err.message);
              }
            }
          })
        );
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

//admin panel create folder
router.post("/upload", upload.array("files"), async (req, res) => {
  try {
    const { folderName, customerId, vendorId, phoneNo } = req.body;

    if (!folderName || !customerId) {
      return res
        .status(400)
        .json({ message: "Folder Name and Customer ID are required." });
    }

    const folder = await Folder.findOne({ folderName }).lean();

    if (!folder) {
      return res.status(404).json({
        message: "Folder not found",
      });
    }

    const mainFolderId = folder._id;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: "No files were uploaded." });
    }

    const folderPath = vendorId
      ? `${folderName}_${customerId}_${vendorId}`
      : `${folderName}_${customerId}`;

    const uploadedFiles = [];

    for (const file of req.files) {
      const filePath = file.path;
      const fileName = file.filename;

      const isImage = file.mimetype.startsWith("image/");
      const isVideo = file.mimetype.startsWith("video/");

      let thumbPath;
      let clipPath;

      try {
        // ================= IMAGE =================
        if (isImage) {
          const thumbName = `thumb_${fileName}.webp`;
          thumbPath = path.join(TEMP_DIR, thumbName);

          await generateThumbnail(filePath, thumbPath);

          const originalRes = await uploadFileToS3(
            filePath,
            fileName,
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

          await WebLink.create({
            orderId: vendorId ? vendorId.toString() : folderName,
            orderById: customerId,
            orderByName: phoneNo || "",
            type: "image",
            originalUrl: originalRes.Location,
            originalKey: originalRes.Key,
            thumbnailImageUrl: thumbRes.Location,
            thumbnailKey: thumbRes.Key,
            videoClipUrl: null,
            videoClipKey: null,
            mainFolderId,
          });

          uploadedFiles.push({
            fileName: file.originalname,
            imageUrl: originalRes.Location,
            thumbnailUrl: thumbRes.Location,
          });
        }

        // ================= VIDEO =================
        else if (isVideo) {
          const clipName = `clip_${fileName}.mp4`;
          clipPath = path.join(TEMP_DIR, clipName);

          await generateVideoPreview(filePath, clipPath, 3);

          const videoRes = await uploadFileToS3(
            filePath,
            fileName,
            folderPath,
            phoneNo,
            file.mimetype
          );

          const clipRes = await uploadFileToS3(
            clipPath,
            clipName,
            folderPath,
            phoneNo,
            "video/mp4"
          );

          await WebLink.create({
            orderId: vendorId ? vendorId.toString() : folderName,
            orderById: customerId,
            orderByName: phoneNo || "",
            type: "video",
            originalUrl: videoRes.Location,
            originalKey: videoRes.Key,
            thumbnailImageUrl: null,
            thumbnailKey: null,
            videoClipUrl: clipRes.Location,
            videoClipKey: clipRes.Key,
            mainFolderId,
          });

          uploadedFiles.push({
            fileName: file.originalname,
            videoUrl: videoRes.Location,
            clipUrl: clipRes.Location,
          });
        }

        else {
          uploadedFiles.push({
            fileName: file.originalname,
            error: "Unsupported file type",
          });
        }

      } catch (error) {
        console.error(`Error processing ${fileName}:`, error.message);
        uploadedFiles.push({
          fileName: file.originalname,
          error: error.message,
        });
      } finally {
        // ✅ Guaranteed cleanup
        const paths = [filePath, thumbPath, clipPath];

        for (const p of paths) {
          if (!p) continue;

          try {
            await fsPromises.unlink(p);
            console.log("Deleted:", p);
          } catch (err) {
            if (err.code !== "ENOENT") {
              console.error("Delete failed:", p, err.message);
            }
          }
        }
      }
    }

    return res.status(201).json({
      message: "Files uploaded successfully.",
      files: uploadedFiles,
    });

  } catch (error) {
    console.error("Upload error:", error);
    return res.status(500).json({
      message: "Server error",
      error: error.message,
    });
  }
});

module.exports = router;




