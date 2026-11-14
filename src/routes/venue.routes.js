const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const fsPromises = require("fs").promises;

const VenueImages = require("../models/venue-images");

const {
  generateThumbnailVenue,
  generateVideoPreview,
  upload,
  uploadFileToS3Wonderland,
} = require("../utils/auth.util");

const TEMP_DIR = path.join(process.cwd(), "tempUploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

router.post(
  "/upload-venue-media/:venueId",
  upload.array("files"),
  async (req, res) => {
    const tempFilesToClean = [];

    try {
      const { venueId } = req.params;
      const { postById, postByName, folder = "venue-media" } = req.body;

      // Validations
      if (!venueId || !mongoose.Types.ObjectId.isValid(venueId)) {
        return res.status(400).json({ message: "Invalid venueId" });
      }

      if (!postById || !mongoose.Types.ObjectId.isValid(postById)) {
        return res.status(400).json({ message: "Invalid postById" });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      req.files.forEach((f) => tempFilesToClean.push(f.path));

      const createdDocs = [];

      for (const file of req.files) {
        const filePath = file.path;
        const fileName = file.filename;

        const isImage = file.mimetype.startsWith("image/");
        const isVideo =
          file.mimetype.startsWith("video/") || file.mimetype === "image/gif";

        if (!isImage && !isVideo) {
          continue;
        }

        const timestamp = Date.now();
        const key = `${folder}/${postById}/${venueId}/${timestamp}-${fileName}`;

        let finalData = {};

        if (isImage) {
          const thumbName = `webp_${timestamp}-${fileName}.webp`;
          const smallThumbName = `thumb150_${timestamp}-${fileName}.webp`;

          const thumbPath = path.join(TEMP_DIR, thumbName);
          const smallThumbPath = path.join(TEMP_DIR, smallThumbName);

          tempFilesToClean.push(thumbPath, smallThumbPath);

          await Promise.all([
            generateThumbnailVenue(filePath, thumbPath, 0, {
              width: 1080,
              quality: 80,
            }),
            generateThumbnailVenue(filePath, smallThumbPath, 0, {
              width: 150,
              height: 150,
              quality: 75,
              fit: "cover",
            }),
          ]);

          const [originalUpload, thumbUpload, smallThumbUpload] =
            await Promise.all([
              uploadFileToS3Wonderland({
                filePath,
                key,
                contentType: file.mimetype,
              }),
              uploadFileToS3Wonderland({
                filePath: thumbPath,
                key: `${folder}/${postById}/${venueId}/${thumbName}`,
                contentType: "image/webp",
              }),
              uploadFileToS3Wonderland({
                filePath: smallThumbPath,
                key: `${folder}/${postById}/${venueId}/${smallThumbName}`,
                contentType: "image/webp",
              }),
            ]);

          finalData = {
            postUrl: originalUpload.Location || originalUpload.location,
            postKey: originalUpload.Key || originalUpload.key || key,
            postWebpUrl: thumbUpload.Location || thumbUpload.location,
            postWebpKey: thumbUpload.Key || thumbUpload.key,
            postSmallThumbUrl:
              smallThumbUpload.Location || smallThumbUpload.location,
            postSmallThumbKey: smallThumbUpload.Key || smallThumbUpload.key,
          };
        }

        else if (isVideo) {
          const clipName = `clip_${timestamp}-${fileName}.mp4`;
          const clipPath = path.join(TEMP_DIR, clipName);

          tempFilesToClean.push(clipPath);

          await generateVideoPreview(filePath, clipPath, 3);

          const [videoUpload, clipUpload] = await Promise.all([
            uploadFileToS3Wonderland({
              filePath,
              key,
              contentType: file.mimetype,
            }),
            uploadFileToS3Wonderland({
              filePath: clipPath,
              key: `${folder}/${postById}/${venueId}/${clipName}`,
              contentType: "video/mp4",
            }),
          ]);

          finalData = {
            postUrl: videoUpload.Location || videoUpload.location,
            postKey: videoUpload.Key || videoUpload.key || key,
            postWebpUrl: clipUpload.Location || clipUpload.location,
            postWebpKey: clipUpload.Key || clipUpload.key,
            postSmallThumbUrl: "",
            postSmallThumbKey: "",
          };
        }

        const doc = await VenueImages.create({
          venueId: new mongoose.Types.ObjectId(venueId),
          postById: new mongoose.Types.ObjectId(postById),
          postByName: postByName || "",
          ...finalData,
          folderIds: [],
        });

        createdDocs.push(doc);
      }

      if (createdDocs.length === 0) {
        return res.status(400).json({
          message: "No valid image or video files were processed",
        });
      }

      return res.status(201).json({
        message: "Venue media uploaded successfully",
        media: createdDocs,
      });
    } catch (err) {
      console.error("Venue upload error:", err);
      return res.status(500).json({
        message: err.message || "Failed to upload venue media",
        error: err.message,
      });
    } finally {
      for (const p of tempFilesToClean) {
        if (!p) continue;
        try {
          await fsPromises.unlink(p);
        } catch (_) {}
      }
    }
  }
);

module.exports = router;
