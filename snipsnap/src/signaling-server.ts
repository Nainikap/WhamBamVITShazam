import { WebRtcSignalingServer, parseIceServers } from './webrtc/signaling';

function port(value: string | undefined): number {
  const parsed = Number(value ?? '8080');
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error('PORT must be an integer from 1 to 65535');
  return parsed;
}

const host = process.env.HOST?.trim() || '0.0.0.0';
const advertisedHost = process.env.SNIPSNAP_SIGNALING_ADVERTISED_HOST?.trim();
const server = new WebRtcSignalingServer({
  host,
  port: port(process.env.PORT),
  ...(advertisedHost ? { advertisedHost } : {}),
  iceServers: parseIceServers(),
});

async function shutdown(): Promise<void> {
  await server.close();
  process.exit(0);
}

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

server.listen().then(({ port: listeningPort }) => {
  process.stdout.write(`SnipSnap WebRTC signaling is listening on ${host}:${listeningPort}\n`);
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
