// import cron from "node-cron";
import yaml from "yaml";
import ky from "ky";
import fs from "fs-extra";
import nodemailer from "nodemailer";
import dayjs from "dayjs";
import isBetween from "dayjs/plugin/isBetween.js";
dayjs.extend(isBetween);

const cacheFile = "./sent.yaml";

const getSchedule = async (from, to, date) => {
  const body = new URLSearchParams();
  body.set("comCode", "LFLV");
  body.set("firstTripUnix", 0);
  body.set("departDate", date);
  body.set("originCode", from);
  body.set("destinationCode", to);
  body.set("totalPax", 2);

  //   return await ky
  //     .post(
  //       "https://www.cuticutilangkawi.com/hcjSystem/executor.php?Ccl/travelApp/modules/checkOut/getTrip",
  //       { body }
  //     )
  //     .json();

  return {
    childDobMin: "2011-12-17",
    childDobMax: "2020-12-16",
    adultDobMin: "1903-12-17",
    adultDobMax: "2011-12-16",
    tripGapMin: 0,
    departTrip: [
      {
        routeID: "4",
        tripID: "88364",
        tripDatetime: "04:00 pm",
        ferryName: "",
        seatStatus: "58/338",
        left: 58,
        unix: 1702713600,
        date: "2023-12-16",
        disable: 0,
      },
      {
        routeID: "4",
        tripID: "87950",
        tripDatetime: "05:00 pm",
        ferryName: "",
        seatStatus: "37/500",
        left: 37,
        unix: 1702717200,
        date: "2023-12-16",
        disable: 0,
      },
      {
        routeID: "4",
        tripID: "87951",
        tripDatetime: "07:00 pm",
        ferryName: "",
        seatStatus: "276/400",
        left: 276,
        unix: 1702724400,
        date: "2023-12-16",
        disable: 0,
      },
    ],
    status: "success",
    errorNo: 0,
    errorMessage: "Load trip successful.",
  };
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
      x.date == configEntry.date && x.trips.some((y) => y.tripID == trip.tripID)
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
      const dayTrip = dayItem.trips.find(
        (trip2) => trip2.tripID == trip.tripID
      );

      if (!dayTrip) {
        dayItem.trips.push({
          tripID: trip.tripID,
          tripDatetime: trip.tripDatetime,
        });
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

(async () => {
  const config = await getConfig();
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
})();

// function logMessage() {
//   console.log("Cron job executed at:", new Date().toLocaleString());
// }

// // Schedule the cron job to run every minute
// cron.schedule("* * * * *", () => {
//   logMessage();
// });
