const express = require("express");
const router = express.Router();
const { handleDriveFolderUpload, uploadSingleImage } = require("../services/drive.service");
const Folder = require("../models/folder");
const fs = require("fs");
const { uploadFileToS3, generateThumbnail, upload, generateVideoPreview, getVideoDuration } = require("../utils/auth.util");
const multer = require("multer");
const path = require("path");
const WebLink = require("../models/weblink-images")
const Weblink = require("../models/weblink-images")
const fsPromises = require("fs").promises;
const AWS = require("aws-sdk");
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');



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
      isLocker = false,
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
      isLocker: isLocker === "true" || isLocker === true,
    };

    const updatedFolder = await Folder.findOneAndUpdate(
      { folderName: folderName },
      { $push: { subFolders: newSubFolder } },
      { new: true }
    );

    const savedSubFolder = updatedFolder.subFolders[updatedFolder.subFolders.length - 1];


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

    const folderPath = folderName;

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
          
          const durationVal = await getVideoDuration(originalPath);

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
            duration: durationVal,
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

router.post("/upload", upload.array("files"), async (req, res) => {
  try {
    const {
      folderName,
      customerId,
      vendorId,
      phoneNo,
      isWeblink = true,
      fileId,
    } = req.body;

    if (!fileId) {
      return res.status(400).json({
        message: "fileId is required",
      });
    }

    if (!folderName || !customerId) {
      return res.status(400).json({
        message: "Folder Name and Customer ID are required.",
      });
    }

    const folder = await Folder.findOne({ folderName }).lean();

    if (!folder) {
      return res.status(404).json({
        message: "Folder not found",
      });
    }

    const mainFolderId = folder._id;

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        message: "No files were uploaded.",
      });
    }

    const folderPath = isWeblink
      ? folderName
      : vendorId
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
      let finalUpdateData = {};

      try {
        // ================= CHECK EXISTING =================

        let existing = await WebLink.findOne({ fileId });

        if (existing) {
          if (existing.status === "done") {
            return res.status(200).json({
              message: "Already uploaded",
              files: [existing],
            });
          }

          if (existing.status === "uploading") {
            return res.status(200).json({
              message: "Already uploading",
              files: [existing],
            });
          }

          if (existing.status === "failed") {
            await WebLink.updateOne(
              { fileId },
              {
                status: "uploading",
                $inc: { retryCount: 1 },
              },
            );
          }
        } else {
          // ================= CREATE LOCK DOC =================

          try {
            await WebLink.create({
              fileId,
              orderId: vendorId ? vendorId.toString() : folderName,
              orderById: customerId,
              orderByName: phoneNo || "",
              status: "uploading",
              mainFolderId,
              type: isVideo ? "video" : "image",

              originalUrl: "pending",
              originalKey: "pending",

              thumbnailImageUrl: "pending",
              thumbnailKey: "pending",

              videoClipUrl: "pending",
              videoClipKey: "pending",
            });
          } catch (err) {
            // ================= RACE CONDITION =================

            if (err.code === 11000) {
              const doc = await WebLink.findOne({ fileId });

              return res.status(200).json({
                message: "Already processing",
                files: [doc],
              });
            }

            throw err;
          }
        }

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
            file.mimetype,
          );

          const thumbRes = await uploadFileToS3(
            thumbPath,
            thumbName,
            folderPath,
            phoneNo,
            "image/webp",
          );

          finalUpdateData = {
            type: "image",

            originalUrl: originalRes.Location,
            originalKey: originalRes.Key,

            thumbnailImageUrl: thumbRes.Location,
            thumbnailKey: thumbRes.Key,
          };
        }

        // ================= VIDEO =================
        else if (isVideo) {
          const clipName = `clip_${fileName}.mp4`;

          clipPath = path.join(TEMP_DIR, clipName);

          await generateVideoPreview(filePath, clipPath, 3);

          const durationVal = await getVideoDuration(filePath);

          const videoRes = await uploadFileToS3(
            filePath,
            fileName,
            folderPath,
            phoneNo,
            file.mimetype,
          );

          const clipRes = await uploadFileToS3(
            clipPath,
            clipName,
            folderPath,
            phoneNo,
            "video/mp4",
          );

          finalUpdateData = {
            type: "video",

            originalUrl: videoRes.Location,
            originalKey: videoRes.Key,

            videoClipUrl: clipRes.Location,
            videoClipKey: clipRes.Key,
            duration: durationVal,
          };
        } else {
          throw new Error("Unsupported file type");
        }

        // ================= UPDATE DONE =================

        const updatedDoc = await WebLink.findOneAndUpdate(
          { fileId },
          {
            ...finalUpdateData,
            status: "done",
          },
          { new: true },
        );

        uploadedFiles.push(updatedDoc);
      } catch (error) {
        console.error(`Error processing ${fileName}:`, error);

        // ================= UPDATE FAILED =================

        await WebLink.findOneAndUpdate(
          { fileId },
          {
            status: "failed",
          },
        );

        uploadedFiles.push({
          fileName: file.originalname,
          error: error.message,
        });
      } finally {
        // ================= CLEANUP =================

        const paths = [filePath, thumbPath, clipPath];

        for (const p of paths) {
          if (!p) continue;

          try {
            await fsPromises.unlink(p);
          } catch {}
        }
      }
    }

    return res.status(201).json({
      message: "Processing complete",
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
router.put(
  "/update-subfolder-dp",
  uploadSingel.single("image"),
  async (req, res) => {
    const { folderId, subFolderId, phoneNo } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No image uploaded" });
    }

    try {
      const folder = await Folder.findById(folderId);
      if (!folder) {
        return res.status(404).json({ message: "Folder not found" });
      }

      const subFolder = folder.subFolders.id(subFolderId);
      if (!subFolder) {
        return res.status(404).json({ message: "Subfolder not found" });
      }

      // ================= DELETE OLD =================
      const keysToDelete = [];

      if (subFolder.folderDp?.s3Key) {
        keysToDelete.push({ Key: subFolder.folderDp.s3Key });
      }

      if (subFolder.folderDp?.thumbnailKey) {
        keysToDelete.push({ Key: subFolder.folderDp.thumbnailKey });
      }

      if (keysToDelete.length > 0) {
        await s3.deleteObjects({
          Bucket: process.env.S3_BUCKET_NAME,
          Delete: { Objects: keysToDelete },
        }).promise();
      }

      // ================= NEW UPLOAD =================
      const filePath = file.path;
      const fileName = file.filename;

      const thumbName = `thumb_${fileName}.webp`;
      const thumbPath = path.join(TEMP_DIR, thumbName);

      await generateThumbnail(filePath, thumbPath);

      // safer phone
      const safePhone =
        phoneNo && typeof phoneNo === "string"
          ? phoneNo.replace(/[^0-9]/g, "")
          : "unknown";

      const originalRes = await uploadFileToS3(
        filePath,
        fileName,
        "subfolder-dp",
        safePhone,
        file.mimetype
      );

      const thumbRes = await uploadFileToS3(
        thumbPath,
        thumbName,
        "subfolder-dp",
        safePhone,
        "image/webp"
      );

      // ================= SAVE IN DB =================
      subFolder.folderDp = {
        fileUrl: originalRes.Location,
        s3Key: originalRes.Key,

        thumbnailUrl: thumbRes.Location,
        thumbnailKey: thumbRes.Key,
      };

      await folder.save();

      // ================= CLEANUP =================
      [filePath, thumbPath].forEach((p) => {
        if (p && fs.existsSync(p)) {
          try {
            fs.unlinkSync(p);
          } catch (err) {
            console.error("Delete failed:", p);
          }
        }
      });

      // ================= RESPONSE =================
      res.json({
        message: "Subfolder DP updated successfully",
        data: subFolder.folderDp,
      });

    } catch (err) {
      console.error("Update failed:", err);
      res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  }
);


// AWS S3 Client
const s3Client = new S3Client({
  region: "eu-north-1",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  },
});

const BUCKET_NAME = "photography-hora";

router.post("/clean-original-images-by-folder", async (req, res) => {
  const { mainFolderId } = req.body;

  if (!mainFolderId) {
    return res.status(400).json({
      success: false,
      message: "mainFolderId is required",
    });
  }

  try {
    const items = await Weblink.find({
      mainFolderId,
      type: "image",
    });

    if (!items.length) {
      return res.status(404).json({
        success: false,
        message: "No images found for this mainFolderId",
      });
    }

    let processedCount = 0;
    let failedCount = 0;
    let skippedCount = 0;

    for (const item of items) {
      try {
        const oldOriginalKey = item.originalKey;

        if (!oldOriginalKey) {
          skippedCount++;
          continue;
        }

        // Already converted
        if (oldOriginalKey.includes("/2880_")) {
          skippedCount++;
          continue;
        }

        console.log(`Processing: ${oldOriginalKey}`);

        // Delete original image from S3
        try {
          await s3Client.send(
            new DeleteObjectCommand({
              Bucket: BUCKET_NAME,
              Key: oldOriginalKey,
            })
          );

          console.log(`Deleted: ${oldOriginalKey}`);
        } catch (deleteError) {
          console.error(
            `Failed to delete ${oldOriginalKey}:`,
            deleteError.message
          );
        }

        // Generate 2880 key
        const keyParts = oldOriginalKey.split("/");

        if (keyParts.length < 2) {
          failedCount++;
          continue;
        }

        const folderPrefix = keyParts[0];
        const fileNameWithExt = keyParts[keyParts.length - 1];

        const lastDotIndex = fileNameWithExt.lastIndexOf(".");

        if (lastDotIndex === -1) {
          failedCount++;
          continue;
        }

        const baseName = fileNameWithExt.substring(0, lastDotIndex);

        const newOriginalKey = `${folderPrefix}/2880_${baseName}.jpeg`;

        // Update DB
        item.originalKey = newOriginalKey;

        // Directly use existing DB value
          item.originalUrl = item.imageUrl2880;

        await item.save();

        processedCount++;

        console.log(
          `Updated: ${item._id}
Old Key: ${oldOriginalKey}
New Key: ${newOriginalKey}
Original URL: ${item.originalUrl}`
        );
      } catch (singleFileError) {
        console.error(
          `Error processing file ${item._id}:`,
          singleFileError
        );
        failedCount++;
      }
    }

    return res.status(200).json({
      success: true,
      message: "Bulk processing completed",
      stats: {
        totalFound: items.length,
        successfullyProcessed: processedCount,
        failed: failedCount,
        skipped: skippedCount,
      },
    });
  } catch (error) {
    console.error("Bulk update error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

router.post("/fix-original-url-by-folder", async (req, res) => {
  const { mainFolderId } = req.body;

  if (!mainFolderId) {
    return res.status(400).json({
      success: false,
      message: "mainFolderId is required",
    });
  }

  try {
    const images = await Weblink.find({
      mainFolderId,
      type: "image",
    });

    let updated = 0;

    for (const image of images) {
      // originalKey se 2880 URL banao
      const originalUrl = `https://photography-hora.s3.eu-north-1.amazonaws.com/${image.originalKey}`;

      await Weblink.updateOne(
        { _id: image._id },
        {
          $set: {
            originalUrl: originalUrl,
          },
        }
      );

      updated++;
    }

    return res.status(200).json({
      success: true,
      totalFound: images.length,
      updated,
    });
  } catch (error) {
    console.error("Fix originalUrl error:", error);

    return res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

module.exports = router;