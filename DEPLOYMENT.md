# EMC RackTrack Deployment

This folder is ready to deploy as a Node.js web app.

## Recommended Option: Render

Use Render if you want one link that your team can open anytime, even when your laptop is off.

1. Create or open a Render account.
2. Create a new Web Service.
3. Upload/connect this `racktrack-online` app folder.
4. Use:
   - Runtime: Node
   - Start command: `npm start`
   - Port: automatic from `PORT`
5. Add a persistent disk mounted at `/var/data`.
6. Add environment variable:
   - `DATA_DIR=/var/data`

Render will give a public link like:

`https://emc-racktrack.onrender.com`

## Passwords

On first server start, the app generates:

- Edit password
- Recovery code

They are written to `server-credentials.txt` locally, or in the cloud server logs / persistent data folder depending on the host.

## Important

Do not use a purely static host for this app. It needs the Node server because all team members must share the same live rack database.
