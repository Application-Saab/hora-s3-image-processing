const express = require("express");
const router = express.Router();
const {
  handleDriveFolderUpload,
  uploadSingleImage,
} = require("../services/drive.service");
const Folder = require("../models/folder");
const eventPosts = require("../models/event-posts");
const mongoose = require("mongoose");
const fs = require("fs");
const {
  uploadFileToS3,
  generateThumbnail,
  upload,
  generateVideoPreview,
  uploadFileToS3Wonderland
} = require("../utils/auth.util");
const multer = require("multer");
const path = require("path");
const WebLink = require("../models/weblink-images");
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
// router.delete("/delete-image/:id", async (req, res) => {
//   const { id } = req.params;

//   try {
//     // Find the image in MongoDB
//     const image = await WebLink.findById(id);
//     if (!image) {
//       return res.status(404).json({ message: "Image not found" });
//     }

//     // Build list of S3 keys to delete
//     const keysToDelete = [];

//     if (image.originalKey) keysToDelete.push({ Key: image.originalKey });
//     if (image.thumbnailKey) keysToDelete.push({ Key: image.thumbnailKey });
//     if (image.videoClipKey) keysToDelete.push({ Key: image.videoClipKey });

//     if (keysToDelete.length > 0) {
//       await s3
//         .deleteObjects({
//           Bucket: process.env.S3_BUCKET_NAME,
//           Delete: { Objects: keysToDelete },
//         })
//         .promise();
//     }

//     // Delete document from MongoDB
//     await WebLink.findByIdAndDelete(id);

//     res.json({ message: "Image deleted successfully" });
//   } catch (err) {
//     console.error("Delete failed:", err);
//     res.status(500).json({ message: "Server error", error: err.message });
//   }
// });

//admin panel create folder
// router.post("/upload-event-media", upload.array("files"), async (req, res) => {
//   try {
//     const { folderName, userId, eventId } = req.body;

//     if (!folderName || !userId || !eventId) {
//       return res
//         .status(400)
//         .json({ message: "Folder Name, User ID, and Event ID are required." });
//     }

//     const key =  `${folder}/${userId}/${eventId}/${Date.now()}-${fileName}`;

//     const folder = await Folder.findOne({ folderName }).lean();

//     if (!folder) {
//       return res.status(404).json({
//         message: "Folder not found",
//       });
//     }

//     const mainFolderId = folder._id;

//     if (!req.files || req.files.length === 0) {
//       return res.status(400).json({ message: "No files were uploaded." });
//     }

//     const folderPath = vendorId
//       ? `${folderName}_${customerId}_${vendorId}`
//       : `${folderName}_${customerId}`;

//     const uploadedFiles = [];

//     for (const file of req.files) {
//       const filePath = file.path;
//       const fileName = file.filename;

//       const isImage = file.mimetype.startsWith("image/");
//       const isVideo = file.mimetype.startsWith("video/");

//       let thumbPath;
//       let clipPath;

//       try {
//         // ================= IMAGE =================
//         if (isImage) {
//           const thumbName = `thumb_${fileName}.webp`;
//           thumbPath = path.join(TEMP_DIR, thumbName);

//           await generateThumbnail(filePath, thumbPath);

//           const originalRes = await uploadFileToS3(
//             filePath,
//             fileName,
//             folderPath,
//             phoneNo,
//             file.mimetype
//           );

//           const thumbRes = await uploadFileToS3(
//             thumbPath,
//             thumbName,
//             folderPath,
//             phoneNo,
//             "image/webp"
//           );

//           await WebLink.create({
//             orderId: vendorId ? vendorId.toString() : folderName,
//             orderById: customerId,
//             orderByName: phoneNo || "",
//             type: "image",
//             originalUrl: originalRes.Location,
//             originalKey: originalRes.Key,
//             thumbnailImageUrl: thumbRes.Location,
//             thumbnailKey: thumbRes.Key,
//             videoClipUrl: null,
//             videoClipKey: null,
//             mainFolderId,
//           });

//           uploadedFiles.push({
//             fileName: file.originalname,
//             imageUrl: originalRes.Location,
//             thumbnailUrl: thumbRes.Location,
//           });
//         }

//         // ================= VIDEO =================
//         else if (isVideo) {
//           const clipName = `clip_${fileName}.mp4`;
//           clipPath = path.join(TEMP_DIR, clipName);

//           await generateVideoPreview(filePath, clipPath, 3);

//           const videoRes = await uploadFileToS3(
//             filePath,
//             fileName,
//             folderPath,
//             phoneNo,
//             file.mimetype
//           );

//           const clipRes = await uploadFileToS3(
//             clipPath,
//             clipName,
//             folderPath,
//             phoneNo,
//             "video/mp4"
//           );

//           await WebLink.create({
//             orderId: vendorId ? vendorId.toString() : folderName,
//             orderById: customerId,
//             orderByName: phoneNo || "",
//             type: "video",
//             originalUrl: videoRes.Location,
//             originalKey: videoRes.Key,
//             thumbnailImageUrl: null,
//             thumbnailKey: null,
//             videoClipUrl: clipRes.Location,
//             videoClipKey: clipRes.Key,
//             mainFolderId,
//           });

//           uploadedFiles.push({
//             fileName: file.originalname,
//             videoUrl: videoRes.Location,
//             clipUrl: clipRes.Location,
//           });
//         }

//         else {
//           uploadedFiles.push({
//             fileName: file.originalname,
//             error: "Unsupported file type",
//           });
//         }

//       } catch (error) {
//         console.error(`Error processing ${fileName}:`, error.message);
//         uploadedFiles.push({
//           fileName: file.originalname,
//           error: error.message,
//         });
//       } finally {
//         // ✅ Guaranteed cleanup
//         const paths = [filePath, thumbPath, clipPath];

//         for (const p of paths) {
//           if (!p) continue;

//           try {
//             await fsPromises.unlink(p);
//             console.log("Deleted:", p);
//           } catch (err) {
//             if (err.code !== "ENOENT") {
//               console.error("Delete failed:", p, err.message);
//             }
//           }
//         }
//       }
//     }

//     return res.status(201).json({
//       message: "Files uploaded successfully.",
//       files: uploadedFiles,
//     });

//   } catch (error) {
//     console.error("Upload error:", error);
//     return res.status(500).json({
//       message: "Server error",
//       error: error.message,
//     });
//   }
// });

router.post(
  "/upload-event-media/:eventId",
  upload.array("files"),
  async (req, res) => {
    try {
      const { eventId } = req.params;

      const { postById, postByName, postType, badgeId, taggedUserIds, folder } =
        req.body;

      if (!eventId || !mongoose.Types.ObjectId.isValid(eventId))
        return res.status(400).json({ message: "Invalid eventId" });

      if (!postById || !mongoose.Types.ObjectId.isValid(postById))
        return res.status(400).json({ message: "Invalid postById" });

      if (!req.files || req.files.length === 0)
        return res.status(400).json({ message: "No files uploaded" });

      const uploadedPosts = [];

      for (const file of req.files) {
        const filePath = file.path;
        const fileName = file.filename;

        const isImage = file.mimetype.startsWith("image/");
        const isVideo = file.mimetype.startsWith("video/");

        let thumbPath;
        let clipPath;

        try {
          const key = `${folder}/${postById}/${eventId}/${Date.now()}-${fileName}`;

          // ================= IMAGE =================
          if (isImage) {
            const thumbName = `thumb_${fileName}.webp`;
            thumbPath = path.join(TEMP_DIR, thumbName);

            await generateThumbnail(filePath, thumbPath);

            const originalUpload = await uploadFileToS3Wonderland({
              filePath,
              key,
              contentType: file.mimetype,
            });

            const thumbKey = `${folder}/${postById}/${eventId}/${thumbName}`;

            const thumbUpload = await uploadFileToS3Wonderland({
              filePath: thumbPath,
              key: thumbKey,
              contentType: "image/webp",
            });

            const newPost = await eventPosts.create({
              eventId,
              postById,
              postByName,
              postType,
              postUrl: originalUpload.Location,
              postKey: originalUpload.Key,
              postWebpUrl: thumbUpload.Location,
              postWebpKey: thumbUpload.Key,
              ...(postType === "postBadge" && {
                badgeId,
                taggedUserIds: Array.isArray(taggedUserIds)
                  ? taggedUserIds
                  : taggedUserIds
                    ? [taggedUserIds]
                    : [],
              }),
            });

            uploadedPosts.push(newPost);
          }

          // ================= VIDEO =================
          else if (isVideo) {
            const clipName = `clip_${fileName}.mp4`;
            clipPath = path.join(TEMP_DIR, clipName);

            await generateVideoPreview(filePath, clipPath, 3);

            const videoUpload = await uploadFileToS3Wonderland({
              filePath,
              key,
              contentType: file.mimetype,
            });

            const clipKey = `${folder}/${postById}/${eventId}/${clipName}`;

            const clipUpload = await uploadFileToS3Wonderland({
              filePath: clipPath,
              key: clipKey,
              contentType: "video/mp4",
            });

            const newPost = await eventPosts.create({
              eventId,
              postById,
              postByName,
              postType,
              postUrl: videoUpload.Location,
              postKey: videoUpload.Key,
              postWebpUrl: clipUpload.Location,
              postWebpKey: clipUpload.Key,
            });

            uploadedPosts.push(newPost);
          }
        } catch (err) {
          console.error("Upload error:", err);
        } finally {
          const paths = [filePath, thumbPath, clipPath];

          for (const p of paths) {
            if (!p) continue;

            try {
              await fsPromises.unlink(p);
            } catch (err) {}
          }
        }
      }

      return res.status(201).json({
        message: "Files uploaded successfully",
        posts: uploadedPosts,
      });
    } catch (err) {
      console.error("Upload error:", err);

      return res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  },
);

module.exports = router;
