import { PrismaClient } from "@prisma/client";
const prisma = new PrismaClient();

async function main() {
  // Central University of Haryana, Mahendergarh campus kiosks.
  const kiosks = [
    { deviceId: "cuh-library-01", name: "Prinsta Kiosk – Central Library", location: "Central Library, Central University of Haryana, Mahendergarh", status: "ONLINE" as const, paperLevel: 92, tonerLevel: 78, latitude: 28.3511, longitude: 76.1475 },
    { deviceId: "cuh-acadblock-01", name: "Prinsta Kiosk – Academic Block", location: "Academic Block, Central University of Haryana, Mahendergarh", status: "ONLINE" as const, paperLevel: 64, tonerLevel: 55, latitude: 28.3525, longitude: 76.1488 },
    { deviceId: "cuh-hostel-01", name: "Prinsta Kiosk – Boys Hostel", location: "Boys Hostel, Central University of Haryana, Mahendergarh", status: "BUSY" as const, paperLevel: 40, tonerLevel: 33, latitude: 28.3495, longitude: 76.1460 },
    { deviceId: "cuh-admin-01", name: "Prinsta Kiosk – Admin Block", location: "Administrative Block, Central University of Haryana, Mahendergarh", status: "OFFLINE" as const, paperLevel: 0, tonerLevel: 12, latitude: 28.3505, longitude: 76.1450 },
  ];
  for (const k of kiosks) {
    await prisma.printer.upsert({ 
      where: { deviceId: k.deviceId }, 
      update: { 
        name: k.name, 
        location: k.location, 
        status: k.status, 
        paperLevel: k.paperLevel, 
        tonerLevel: k.tonerLevel,
        latitude: k.latitude,
        longitude: k.longitude
      }, 
      create: k 
    });
  }
  // Remove the old placeholder kiosk if present (ignore if referenced by orders).
  try {
    await prisma.printer.deleteMany({ where: { deviceId: "kiosk-lib-01" } });
    await prisma.printer.deleteMany({ where: { deviceId: "cuh-boyshostel-01" } });
  } catch {
    await prisma.printer.updateMany({ where: { deviceId: "kiosk-lib-01" }, data: { status: "OFFLINE" } });
    await prisma.printer.updateMany({ where: { deviceId: "cuh-boyshostel-01" }, data: { status: "OFFLINE" } });
  }

  console.log("Seed complete.");
}

main().finally(() => prisma.$disconnect());
