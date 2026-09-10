import mongoose from "mongoose";

// Cached on globalThis so that within one warm serverless container
// (Vercel, Lambda, etc.) repeated invocations reuse the same connection
// instead of opening a new one per request. In a traditional long-running
// server this just means connectDB() only ever does real work once.
const cached = globalThis.__mongooseConn || (globalThis.__mongooseConn = { conn: null, promise: null });

export default async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("⚠️  MONGODB_URI not set — running without a database connection.");
    return null;
  }
  if (cached.conn) return cached.conn;
  if (!cached.promise) {
    cached.promise = mongoose.connect(uri).then((m) => {
      console.log("✅ MongoDB connected");
      return m;
    });
  }
  try {
    cached.conn = await cached.promise;
  } catch (err) {
    cached.promise = null;
    console.error("❌ MongoDB connection failed:", err.message);
    throw err;
  }
  return cached.conn;
}
