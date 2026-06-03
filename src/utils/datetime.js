const UZ_TIME_ZONE = "Asia/Tashkent";

const uzDateFormatter = new Intl.DateTimeFormat("uz-UZ", {
  timeZone: UZ_TIME_ZONE,
});

const uzTimeFormatter = new Intl.DateTimeFormat("uz-UZ", {
  timeZone: UZ_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

const isoDateFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: UZ_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export const toUzDate = (date = new Date()) => uzDateFormatter.format(date);

export const toUzTime = (date = new Date()) => uzTimeFormatter.format(date);

export const toISODate = (date = new Date()) => {
  const parts = Object.fromEntries(
    isoDateFormatter
      .formatToParts(date)
      .filter(({ type }) => ["year", "month", "day"].includes(type))
      .map(({ type, value }) => [type, value]),
  );

  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const formatDuration = (start, end = new Date()) => {
  const minutesTotal = Math.max(0, Math.floor((end - start) / 1000 / 60));
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;

  return hours > 0 ? `${hours} soat ${minutes} daqiqa` : `${minutes} daqiqa`;
};
