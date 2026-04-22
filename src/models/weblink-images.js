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
      default: null,
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
      sparse: true,
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
      required: true,
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
      required: true,
      index: true,
    },

    originalUrl: {
      type: String,
      required: true,
      trim: true,
    },

   originalKey: {
  type: String,
  unique: true,
  sparse: true, 
  default: null
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
    }
  },
  {
    timestamps: true,
    versionKey: false,
  }
);

module.exports = mongoose.model("weblinks", weblinkSchema);
