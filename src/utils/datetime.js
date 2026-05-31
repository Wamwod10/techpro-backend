export const toUzDate = (date = new Date()) => date.toLocaleDateString("uz-UZ");

export const toUzTime = (date = new Date()) =>
  date.toLocaleTimeString("uz-UZ", {
    hour: "2-digit",
    minute: "2-digit",
  });

export const toISODate = (date = new Date()) => date.toISOString().slice(0, 10);

export const formatDuration = (start, end = new Date()) => {
  const minutesTotal = Math.max(0, Math.floor((end - start) / 1000 / 60));
  const hours = Math.floor(minutesTotal / 60);
  const minutes = minutesTotal % 60;

  return hours > 0 ? `${hours} soat ${minutes} daqiqa` : `${minutes} daqiqa`;
};
