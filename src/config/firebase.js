const admin = require('firebase-admin');
const env = require('./env');

// Khởi tạo Firebase Admin một lần duy nhất.
// Ưu tiên biến FIREBASE_*; nếu thiếu thì dùng GOOGLE_APPLICATION_CREDENTIALS.
if (!admin.apps.length) {
  const { projectId, clientEmail, privateKey } = env.firebase;
  admin.initializeApp({
    credential:
      projectId && clientEmail && privateKey
        ? admin.credential.cert({ projectId, clientEmail, privateKey })
        : admin.credential.applicationDefault(),
  });
}

module.exports = {
  admin,
  auth: admin.auth(),
  db: admin.firestore(),
};
