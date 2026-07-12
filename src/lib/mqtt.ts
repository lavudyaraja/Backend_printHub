// MQTT bridge — backend <-> IoT print agents (Raspberry Pi).
// Topics:
//   prinsta/printer/{deviceId}/job     -> backend publishes print job
//   prinsta/printer/{deviceId}/status  -> device publishes status/telemetry
import mqtt, { MqttClient } from "mqtt";
import { prisma } from "./prisma";
import { config } from "./config";

let client: MqttClient;

export function initMqtt(onJobUpdate: (payload: any) => void) {
  // mqtt.connect handles mqtts:// (TLS) and user:pass@host auth from the URL.
  client = mqtt.connect(config.mqttUrl, {
    reconnectPeriod: 3000, // auto-retry every 3s while disconnected
    connectTimeout: 30_000,
    keepalive: 60,
    clean: true,
  });

  client.on("connect", () => {
    console.log("[mqtt] connected");
    client.subscribe("prinsta/printer/+/status");
    client.subscribe("prinsta/printer/+/job-result");
  });
  client.on("reconnect", () => console.log("[mqtt] reconnecting…"));
  client.on("offline", () => console.warn("[mqtt] offline"));
  client.on("error", (err) => console.error("[mqtt] error", err.message));

  client.on("message", async (topic, message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (topic.endsWith("/status")) {
        await handleStatus(payload);
      } else if (topic.endsWith("/job-result")) {
        onJobUpdate(payload);
      }
    } catch (e) {
      console.error("[mqtt] bad message", topic, e);
    }
  });

  return client;
}

async function handleStatus(p: {
  deviceId: string;
  status?: string;
  paperLevel?: number;
  tonerLevel?: number;
}) {
  await prisma.printer.updateMany({
    where: { deviceId: p.deviceId },
    data: {
      status: (p.status as any) || undefined,
      paperLevel: p.paperLevel,
      tonerLevel: p.tonerLevel,
      lastSeenAt: new Date(),
    },
  });
}

// Push a print command to a specific device.
export function publishJob(deviceId: string, job: unknown) {
  if (!client) {
    console.warn("[mqtt] client not initialized — cannot publish job");
    return;
  }
  client.publish(`prinsta/printer/${deviceId}/job`, JSON.stringify(job), { qos: 1 });
}
