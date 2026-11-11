-- The audio bucket is private, but the "MixForge public read audio" policy let anyone holding the
-- app's public key list and download every file. MixForge, Release Forge and Pipe Dreams read audio
-- only through short-lived signed links made server-side, so no public read is needed.
-- Uploads keep working: they need only the existing insert policy (x-upsert false).
drop policy if exists "MixForge public read audio" on storage.objects;
