import cron from "node-cron";
import yaml from "yaml";
import got from "got";
import fs from "fs-extra";
import nodemailer from "nodemailer";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween.js";
dayjs.extend(isBetween);

const cacheFile = "./sent.yaml";
const errFile = "./error.yaml";

const getSchedule = async (from, to, date) => {
  const form = {
    comCode: "LFLV",
    firstTripUnix: 0,
    departDate: date,
    originCode: from,
    destinationCode: to,
    totalPax: 2,
  };

  return await got
    .post(
      "https://www.cuticutilangkawi.com/hcjSystem/executor.php?Ccl/travelApp/modules/checkOut/getTrip",
      { form }
    )
    .json();
};

const filterValidConfig = (configEntry) => {
  if (!configEntry.enabled) return false;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const entryDate = new Date(configEntry.date);

  if (isNaN(entryDate) || entryDate < today) {
    return false;
  }

  const places = ["KP", "KK", "PL"];
  if (!places.includes(configEntry.from) || !places.includes(configEntry.to)) {
    return false;
  }

  return true;
};

const getConfig = async () => {
  const config = yaml.parse((await fs.readFile("./config.yaml")).toString());
  config.watch = config.watch.filter(filterValidConfig);

  return config;
};

const filterCondition = (configEntry, cache) => (trip) => {
  const tripTime = dayjs(
    `${dayjs().startOf("day").format("YYYY-MM-DD")} ${trip.tripDatetime}`,
    "YYYY-MM-DD hh:mm a"
  );
  const configStart = dayjs(
    `${dayjs().startOf("day").format("YYYY-MM-DD")} ${
      configEntry.condition.between.start
    }`,
    "YYYY-MM-DD hh:mm a"
  );
  const configEnd = dayjs(
    `${dayjs().startOf("day").format("YYYY-MM-DD")} ${
      configEntry.condition.between.end
    }`,
    "YYYY-MM-DD hh:mm a"
  );

  const inCache = cache.some(
    (x) =>
      x.date == configEntry.date &&
      x.trips.some(
        (y) => y.tripID == trip.tripID && y.ferryName == trip.ferryName
      )
  );

  return tripTime.isBetween(configStart, configEnd, "minute", "[]") && !inCache;
};

const sendNotification = async (configMail, watchTrips) => {
  if (watchTrips.length == 0) {
    return;
  }

  let html = "";

  watchTrips.forEach(({ config, trips }) => {
    html += `<div>Date: <b>${config.date}</b></div>`;
    html += `<div>Route: <b>${config.from}-${config.to}</b></div>`;
    html += `<div><ul>`;
    trips.forEach((trip) => {
      html += `<li><b>${trip.tripDatetime}</b> (name: ${trip.ferryName}, seat: ${trip.seatStatus})</li>`;
    });
    html += `</ul></div><br />`;
  });

  const transporter = nodemailer.createTransport(configMail.smtp);

  await transporter.sendMail({
    from: configMail.from, // sender address
    to: configMail.to, // list of receivers
    subject: "Update feri", // Subject line
    html, // html body
  });
};

const sendError = async (configMail, error) => {
  const transporter = nodemailer.createTransport(configMail.smtp);

  await transporter.sendMail({
    from: configMail.from, // sender address
    to: configMail.to, // list of receivers
    subject: "Error on feri watcher", // Subject line
    html: error.exception, // html body
  });
};

const markedAsCompleted = async (watchTrips, cache) => {
  watchTrips.forEach(({ config, trips }) => {
    const dayItemIndex = cache.findIndex((item) => item.date == config.date);

    const dayItem =
      dayItemIndex > -1
        ? cache[dayItemIndex]
        : {
            date: config.date,
            trips: [],
          };

    trips.forEach((trip) => {
      const dayTripIndex = dayItem.trips.findIndex(
        (trip2) => trip2.tripID == trip.tripID
      );

      const newDayTrip = {
        tripID: trip.tripID,
        tripDatetime: trip.tripDatetime,
        ferryName: trip.ferryName,
      };

      if (dayTripIndex > -1) {
        dayItem.trips[dayTripIndex] = newDayTrip;
      } else {
        dayItem.trips.push(newDayTrip);
      }
    });

    if (dayItemIndex > -1) {
      cache[dayItemIndex] = dayItem;
    } else {
      cache.push(dayItem);
    }
  });

  await fs.writeFile(cacheFile, yaml.stringify(cache));
};

const main = async () => {
  console.log(`Cron job executed at: ${new Date().toLocaleString()}`);

  const error =
    yaml.parse((await fs.readFile(errFile).catch(() => "")).toString()) || {};
  if (error.cycle && error.cycle % 3 != 0) {
    error.cycle += 1;
    await fs.writeFile(errFile, yaml.stringify(error));

    return;
  }

  const config = await getConfig();

  try {
    await fs.ensureFile(cacheFile);
    const cache = yaml.parse((await fs.readFile(cacheFile)).toString()) || [];

    const watchTrips = (
      await Promise.all(
        config.watch.map(async (entry) => {
          const allTrips = await getSchedule(entry.from, entry.to, entry.date);
          const watchTrips = allTrips.departTrip.filter(
            filterCondition(entry, cache)
          );

          return { config: entry, trips: watchTrips };
        })
      )
    ).filter((x) => x.trips.length > 0);

    await sendNotification(config.mail, watchTrips);
    await markedAsCompleted(watchTrips, cache);

    // no error. remove error file
    if (error.cycle) {
      await fs.remove(errFile);
    }
  } catch (e) {
    error.cycle = (error.cycle || 0) + 1;
    error.exception = e.stack;

    await fs.writeFile(errFile, yaml.stringify(error));

    if (error.cycle == 1) {
      await sendError(config.mail, error);
    }
  }
};

(async () => {
  const config = await getConfig();
  console.log(
    `Cron is running: ${config.cron} - ${new Date().toLocaleString()}`
  );

  cron.schedule(config.cron, async () => {
    await main();
  });
})();
