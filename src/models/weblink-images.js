const mongoose = require("mongoose");

const weblinkSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toString(),
    },
    mainFolderId: {
      type: String,
      trim: true,
      index: true,
      default: "",
    },
    driveFileId: {
      type: String,
      index: true
    },
    orderId: {
      type: String, // changed from ObjectId
      ref: "order",
      required: true,
      index: true,

    },

    fileId: {
      type: String,
      unique: true,
    },
    status: {
      type: String,
      enum: ["uploading", "done", "failed"],
      default: "uploading",
    },
    retryCount: {
      type: Number,
      default: 0,
    },

    orderById: {
      type: String,
      trim: true,
      index: true,
    },

    orderByName: {
      type: String,
      trim: true,
    },
    type: {
      type: String,
      enum: ["image", "video"],
      default: "",

      index: true,
    },

    originalUrl: {
      type: String,
      trim: true,
    },

    originalKey: {
      type: String,
      default: ""
    },

    thumbnailImageUrl: {
      type: String,
      trim: true,
    },

    thumbnailKey: {
      type: String,
      trim: true,
    },

    videoClipUrl: {
      type: String,
      trim: true,
    },

    videoClipKey: {
      type: String,
      trim: true,
    },

    folderIds: {
      type: [String],
      default: [],
      index: true,
    },
    likedBy: {
      type: [String],
      default: [],
      index: true,
    },
    downloadCount: { type: Number, default: 0 },
    shareCount: { type: Number, default: 0 },
  },
  {
    timestamps: true,
    versionKey: false,
  }
);


weblinkSchema.index(
  {
    unique: true,
    partialFilterExpression: {
      driveFileId: { $ne: null },
      orderId: { $ne: null }
    }
  }
);


module.exports = mongoose.model("weblinks", weblinkSchema);
