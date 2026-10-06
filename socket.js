const { Server } = require("socket.io");

let io = null;

function initSocket(server) {
    io = new Server(server, {
        path: "/socket.io",
        cors: {
            origin: ["https://horaservices.com", "http://localhost:3000", "http://localhost:4700"],
            methods: ["GET", "POST"],
            credentials: true,
        },
        transports: ["websocket", "polling"],
    });

    io.on("connection", (socket) => {
        const userId = socket.handshake.query.userId;
        if (!userId || userId === "null") {
            socket.disconnect(true);
            return;
        }

        socket.userId = String(userId);
        socket.join(socket.userId); // user room

        // Frontend jis folder ko dekh raha hai uska room join kare
        socket.on("joinFolder", ({ folderId }) => {
            if (folderId) socket.join(`folder:${folderId}`);
        });

        socket.on("leaveFolder", ({ folderId }) => {
            if (folderId) socket.leave(`folder:${folderId}`);
        });
    });

    return io;
}

function getIO() {
    if (!io) throw new Error("Socket.IO not initialized yet! Call initSocket first.");
    return io;
}

// user room + folder room dono me ek hi baar emit hoga (duplicate nahi)
function emitToSupplier({ userId, folderId }, event, payload) {
    if (!io) return;
    let target = io.to(String(userId));
    if (folderId) target = target.to(`folder:${folderId}`);
    target.emit(event, payload);
}

module.exports = { initSocket, getIO, emitToSupplier };