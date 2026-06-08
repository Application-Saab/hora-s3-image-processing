const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const fs = require("fs");
const path = require("path");
const fsPromises = require("fs").promises;

const VenueImages = require("../models/venue-images");

const {
  generateThumbnail,
  upload,
  uploadFileToS3Wonderland,
} = require("../utils/auth.util");

const TEMP_DIR = path.join(process.cwd(), "tempUploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

router.post(
  "/upload-venue-media/:venueId",
  upload.array("files"),
  async (req, res) => {
    try {
      const { venueId } = req.params;
      const { postById, postByName, folder } = req.body;

      // validations
      if (!venueId || !mongoose.Types.ObjectId.isValid(venueId)) {
        return res.status(400).json({ message: "Invalid venueId" });
      }

      if (!postById || !mongoose.Types.ObjectId.isValid(postById)) {
        return res.status(400).json({ message: "Invalid postById" });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      const createdDocs = [];

      for (const file of req.files) {
        const filePath = file.path;
        const fileName = file.filename;

        const isImage = file.mimetype.startsWith("image/");

        if (!isImage) {
          // skip non-image for venue (or you can throw error)
          continue;
        }

        let thumbPath;

        try {
          const key = `${folder}/${postById}/${venueId}/${Date.now()}-${fileName}`;

          // create webp thumbnail
          const thumbName = `webp_${fileName}.webp`;
          thumbPath = path.join(TEMP_DIR, thumbName);

          await generateThumbnail(filePath, thumbPath);

          // upload original image
          const originalUpload = await uploadFileToS3Wonderland({
            filePath,
            key,
            contentType: file.mimetype,
          });

          // upload webp thumbnail
          const thumbUpload = await uploadFileToS3Wonderland({
            filePath: thumbPath,
            key: `${folder}/${postById}/${venueId}/${thumbName}`,
            contentType: "image/webp",
          });

          // save DB
          const doc = await VenueImages.create({
            venueId,
            postById,
            postByName,
            postUrl: originalUpload.Location,
            postKey: originalUpload.Key,
            postWebpUrl: thumbUpload.Location,
            postWebpKey: thumbUpload.Key,
            folderIds: [],
          });

          createdDocs.push(doc);
        } catch (err) {
          console.error("Single file upload error:", err);
        } finally {
          // cleanup temp files
          const paths = [filePath, thumbPath];
          for (const p of paths) {
            if (!p) continue;
            try {
              await fsPromises.unlink(p);
            } catch {}
          }
        }
      }

      return res.status(201).json({
        message: "Venue images uploaded successfully",
        images: createdDocs,
      });
    } catch (err) {
      console.error("Venue upload error:", err);

      return res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  }
);

module.exports = router;