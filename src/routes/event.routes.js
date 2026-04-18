const express = require("express");
const router = express.Router();
const eventPosts = require("../models/event-posts");
const mongoose = require("mongoose");
const fs = require("fs");
const {
  generateThumbnail,
  upload,
  generateVideoPreview,
  uploadFileToS3Wonderland,
} = require("../utils/auth.util");
const path = require("path");
const fsPromises = require("fs").promises;

const TEMP_DIR = path.join(process.cwd(), "tempUploads");
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

router.post(
  "/upload-event-media/:eventId",
  upload.array("files"),
  async (req, res) => {
    try {
      const { eventId } = req.params;

      const {
        postById,
        postByName,
        postType,
        badgeId,
        taggedUserIds,
        folder,
        fileId,
      } = req.body;
      console.log('%c [ req.body ]-54', 'font-size:13px; background:pink; color:#bf2c9f;', req.body)

      if (!fileId) {
        return res.status(400).json({ message: "fileId required" });
      }

      if (!eventId || !mongoose.Types.ObjectId.isValid(eventId)) {
        return res.status(400).json({ message: "Invalid eventId" });
      }

      if (!postById || !mongoose.Types.ObjectId.isValid(postById)) {
        return res.status(400).json({ message: "Invalid postById" });
      }

      if (!req.files || req.files.length === 0) {
        return res.status(400).json({ message: "No files uploaded" });
      }

      // CHECK EXISTING
      let existing = await eventPosts.findOne({ fileId });

      if (existing) {
        if (existing.status === "done") {
          return res.status(200).json({
            message: "Already uploaded",
            posts: [existing],
          });
        }

        if (existing.status === "uploading") {
          return res.status(200).json({
            message: "Already uploading",
            posts: [existing],
          });
        }

        if (existing.status === "failed") {
          // allow retry
          await eventPosts.updateOne(
            { fileId },
            {
              status: "uploading",
              $inc: { retryCount: 1 },
            }
          );
        }
      } else {
        // CREATE LOCK DOC
        try {
          await eventPosts.create({
            fileId,
            eventId,
            postById,
            postByName,
            postType,
            status: "uploading",
            postUrl: "pending",
            postKey: "pending",
            postWebpUrl: "pending",
            postWebpKey: "pending",
          });
        } catch (err) {
          // race condition (duplicate key)
          if (err.code === 11000) {
            const doc = await eventPosts.findOne({ fileId });

            return res.status(200).json({
              message: "Already processing",
              posts: [doc],
            });
          }
          throw err;
        }
      }

      // PROCESS FILE
      const file = req.files[0];

      const filePath = file.path;
      const fileName = file.filename;

      const isImage = file.mimetype.startsWith("image/");
      const isVideo = file.mimetype.startsWith("video/");

      let finalData = {};
      let thumbPath;
      let clipPath;

      try {
        const key = `${folder}/${postById}/${eventId}/${Date.now()}-${fileName}`;

        if (isImage) {
          const thumbName = `thumb_${fileName}.webp`;
          thumbPath = path.join(TEMP_DIR, thumbName);

          await generateThumbnail(filePath, thumbPath);

          const originalUpload = await uploadFileToS3Wonderland({
            filePath,
            key,
            contentType: file.mimetype,
          });

          const thumbUpload = await uploadFileToS3Wonderland({
            filePath: thumbPath,
            key: `${folder}/${postById}/${eventId}/${thumbName}`,
            contentType: "image/webp",
          });

          finalData = {
            postUrl: originalUpload.Location,
            postKey: originalUpload.Key,
            postWebpUrl: thumbUpload.Location,
            postWebpKey: thumbUpload.Key,
          };
        }

        else if (isVideo) {
          const clipName = `clip_${fileName}.mp4`;
          clipPath = path.join(TEMP_DIR, clipName);

          await generateVideoPreview(filePath, clipPath, 3);

          const videoUpload = await uploadFileToS3Wonderland({
            filePath,
            key,
            contentType: file.mimetype,
          });

          const clipUpload = await uploadFileToS3Wonderland({
            filePath: clipPath,
            key: `${folder}/${postById}/${eventId}/${clipName}`,
            contentType: "video/mp4",
          });

          finalData = {
            postUrl: videoUpload.Location,
            postKey: videoUpload.Key,
            postWebpUrl: clipUpload.Location,
            postWebpKey: clipUpload.Key,
          };
        }

        const updatedPost = await eventPosts.findOneAndUpdate(
          { fileId },
          {
            ...finalData,
            status: "done",
            ...(postType === "postBadge" && {
              badgeId,
              taggedUserIds: Array.isArray(taggedUserIds)
                ? taggedUserIds
                : taggedUserIds
                ? [taggedUserIds]
                : [],
            }),
          },
          { new: true }
        );

        return res.status(201).json({
          message: "Upload success",
          posts: [updatedPost],
        });
      } catch (err) {
        await eventPosts.findOneAndUpdate(
          { fileId },
          { status: "failed" }
        );

        throw err;
      } finally {
        const paths = [filePath, thumbPath, clipPath];

        for (const p of paths) {
          if (!p) continue;
          try {
            await fsPromises.unlink(p);
          } catch {}
        }
      }
    } catch (err) {
      console.error("Upload error:", err);

      return res.status(500).json({
        message: "Server error",
        error: err.message,
      });
    }
  }
);
module.exports = router;
