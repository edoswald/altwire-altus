export function isoDateOffset(daysBack) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysBack);
  return d.toISOString().slice(0, 10);
}

export function getLagAwareGscWindow(days = 28, lagDays = 3) {
  return {
    startDate: isoDateOffset(days + lagDays),
    endDate: isoDateOffset(lagDays),
  };
}
