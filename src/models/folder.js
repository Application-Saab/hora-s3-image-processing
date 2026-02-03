// const mongoose = require('mongoose');

// // Define the schema
// const FolderSchema = new mongoose.Schema({
//   folderName: {
//     type: String,
//     required: true,
//     trim: true,
//   },
//   customerId: {
//     type: String,
//     required: true,
//     unique: true, // Ensures that the custom ID is unique
//   },
//   vendorId: {
//     type: String
//   },
//   createdAt: {
//     type: Date,
//     default: Date.now, // Automatically adds a creation timestamp
//   },
// });

// // Create the model
// const Folder = mongoose.model('Folder', FolderSchema);

// module.exports = Folder;


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
  fileUrl: { type: String, required: true },
  thumbnailUrl: { type: String, required: true },
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
