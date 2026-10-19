/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native module; keep it out of the server bundle.
  serverExternalPackages: ['better-sqlite3'],
  poweredByHeader: false,
};

export default nextConfig;
