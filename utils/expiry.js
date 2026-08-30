// utils/expiry.js
// Configurable days-to-expiry per ticker. Source of truth: persisted settings (dashboard).

var settings = require("./settings");

var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function getDTE(ticker) {
  return settings.getDTE(ticker);
}

function weekdayET(date) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(date);
}

function ymdInET(date) {
  return date.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function nextTradingDay(from) {
  var cursor = new Date(from || Date.now());
  for (var i = 0; i < 8; i++) {
    var wd = weekdayET(cursor);
    if (wd !== "Sat" && wd !== "Sun") return cursor;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return cursor;
}

function addTradingDaysFromToday(dte) {
  var cursor = nextTradingDay(new Date());
  var added = 0;
  while (added < dte) {
    cursor = new Date(cursor.getTime() + 86400000);
    var wd = weekdayET(cursor);
    if (wd !== "Sat" && wd !== "Sun") added++;
  }
  return cursor;
}

function getExpiryDate(ticker) {
  return addTradingDaysFromToday(getDTE(ticker));
}

function getExpiryDateForDTE(dte) {
  return addTradingDaysFromToday(dte);
}

function getExpiry(ticker) {
  return ymdInET(getExpiryDate(ticker));
}

function getExpiryForDTE(dte) {
  return ymdInET(getExpiryDateForDTE(dte));
}

function getDTELabel(ticker) {
  return getDTE(ticker) + "DTE";
}

function formatExpiryLabel(ymd) {
  if (!ymd || ymd.indexOf("-") === -1) return ymd || "";
  var parts = ymd.split("-");
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);
  var ord = (day % 10 === 1 && day !== 11) ? "st"
    : (day % 10 === 2 && day !== 12) ? "nd"
    : (day % 10 === 3 && day !== 13) ? "rd" : "th";
  return MONTHS[month - 1] + " " + day + ord;
}

function getExpiryInfo(ticker) {
  var dte = getDTE(ticker);
  var expiry = getExpiry(ticker);
  var date = getExpiryDate(ticker);
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(date);
  return {
    ticker: ticker,
    dte: dte,
    expiry: expiry,
    label: dte + "DTE",
    formatted: formatExpiryLabel(expiry),
    weekday: weekday
  };
}

function contractLabel(ticker, side, strike, ymd) {
  var s = (strike === null || strike === undefined) ? "?" : strike;
  var sideLabel = side === "call" ? "Call" : "Put";
  return "$" + ticker + " " + s + " " + sideLabel + " - " + formatExpiryLabel(ymd);
}

module.exports = {
  getDTE: getDTE,
  getExpiryDate: getExpiryDate,
  getExpiry: getExpiry,
  getExpiryForDTE: getExpiryForDTE,
  getExpiryDateForDTE: getExpiryDateForDTE,
  getDTELabel: getDTELabel,
  getExpiryInfo: getExpiryInfo,
  formatExpiryLabel: formatExpiryLabel,
  contractLabel: contractLabel
};
