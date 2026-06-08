const mongoose = require("mongoose");

const FolderSchema = new mongoose.Schema(
  {
    _id: {
      type: String,
      default: () => new mongoose.Types.ObjectId().toString(),
    },
    folderName: {
      type: String,
      required: true,
      trim: true,
    },
    viewedBy: {
      type: [String], // userIds
      default: [],
      index: true
    },
    clickCount: {
      type: Number,
      default: 0
    },
    customerId: {
      type: String,
      required: true,
      index: true,
    },
    vendorId: {
      type: String,
      index: true,
    },
    eventId: {
      type: String,
      ref: "eventInvites",
      index: true,
    },
    orderId: {
      type: String,
      ref: "orders",
      index: true,
    },
    totalPersonCount: {
      type: Number,
      default: 0,
    }, 
    deviceTracking: [
      {
        userId: {
          type: String,
          index: true,
        },
        deviceType: {
          type: String,
          enum: ["ios", "android"],
        },
        trackedAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],

    subFolders: [
      {
        _id: {
          type: String,
          default: () => new mongoose.Types.ObjectId().toString(),
        },
        folderName: {
          type: String,
          required: true,
          trim: true,
        },
        type: {
          type: String,
          enum: ["my_photos", "others"],
          required: true,
        },
        userId: {
          type: String,
          required: true,
          index: true,
        },
        folderDp: {
          fileUrl: { type: String },
          thumbnailUrl: { type: String },
          s3Key: { type: String },
          thumbnailKey: { type: String }
        },

        createdAt: {
          type: Date,
          default: Date.now,
        },
      },
    ],
  },
  { timestamps: true }
);

FolderSchema.index(
  { customerId: 1, eventId: 1 },
  {
    unique: true,
    partialFilterExpression: {
      eventId: { $exists: true }
    }
  }
);


module.exports = mongoose.model("Folder", FolderSchema);
