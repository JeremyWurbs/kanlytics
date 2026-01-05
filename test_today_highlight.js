/**
 * Diagnostic tests for "Today" highlighting issue in Calendar Weeks mode
 * 
 * Problem: When time axis is set to "Calendar weeks", the red highlight
 * appears in February instead of January (where January 5th should be).
 * 
 * Today's date: January 5th, 2025 (UK time)
 */

// Helper functions matching the GanttChart component logic
function parseIsoDateUtc(iso) {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec((iso || "").trim());
  if (!m) return null;
  const yy = Number(m[1]);
  const mm = Number(m[2]);
  const dd = Number(m[3]);
  if (!Number.isFinite(yy) || !Number.isFinite(mm) || !Number.isFinite(dd)) return null;
  return Date.UTC(yy, mm - 1, dd);
}

// Test configuration
const TODAY_YEAR = 2025;
const TODAY_MONTH = 0; // January (0-indexed)
const TODAY_DATE = 5;
const todayUtc = Date.UTC(TODAY_YEAR, TODAY_MONTH, TODAY_DATE);

// Simulate different baseUtc scenarios
const testCases = [
  {
    name: "Base from December 15, 2024 (shared axis scenario)",
    baseUtc: Date.UTC(2024, 11, 15), // Dec 15, 2024
  },
  {
    name: "Base from December 28, 2024 (from image)",
    baseUtc: Date.UTC(2024, 11, 28), // Dec 28, 2024
  },
  {
    name: "Base from January 1, 2025",
    baseUtc: Date.UTC(2025, 0, 1), // Jan 1, 2025
  },
  {
    name: "Base from January 5, 2025 (today)",
    baseUtc: Date.UTC(2025, 0, 5), // Jan 5, 2025
  },
];

const MS_DAY = 24 * 60 * 60 * 1000;

console.log("=".repeat(80));
console.log("DIAGNOSTIC TESTS FOR TODAY HIGHLIGHTING ISSUE");
console.log("Today's date: January 5th, 2025");
console.log(`todayUtc: ${todayUtc} (${new Date(todayUtc).toISOString()})`);
console.log("=".repeat(80));
console.log();

testCases.forEach((testCase, idx) => {
  console.log(`\n${idx + 1}. ${testCase.name}`);
  console.log("-".repeat(80));
  
  const baseUtc = testCase.baseUtc;
  const baseDate = new Date(baseUtc);
  console.log(`   baseUtc: ${baseUtc} (${baseDate.toISOString()})`);
  
  // Calculate todayDayIndex
  const todayDayIndex = Math.floor((todayUtc - baseUtc) / MS_DAY);
  console.log(`   todayDayIndex: ${todayDayIndex}`);
  
  // Verify: baseUtc + todayDayIndex * MS_DAY should equal todayUtc
  const calculatedTodayUtc = baseUtc + todayDayIndex * MS_DAY;
  const diff = Math.abs(calculatedTodayUtc - todayUtc);
  console.log(`   Calculated todayUtc: ${calculatedTodayUtc} (${new Date(calculatedTodayUtc).toISOString()})`);
  console.log(`   Difference: ${diff}ms (${diff / MS_DAY} days)`);
  if (diff > 0) {
    console.log(`   ⚠️  PROBLEM: todayDayIndex calculation is off by ${diff}ms`);
  }
  
  // Calculate week start for today
  const todayDateObj = new Date(todayUtc);
  const todayDow = todayDateObj.getUTCDay(); // 0=Sunday, 6=Saturday
  const todayWeekStartUtc = Date.UTC(
    todayDateObj.getUTCFullYear(),
    todayDateObj.getUTCMonth(),
    todayDateObj.getUTCDate() - todayDow
  );
  const todayWeekStartDate = new Date(todayWeekStartUtc);
  console.log(`   Today is: ${todayDateObj.toISOString().slice(0, 10)} (day of week: ${todayDow})`);
  console.log(`   Week start (Sunday): ${todayWeekStartDate.toISOString().slice(0, 10)}`);
  console.log(`   todayWeekStartUtc: ${todayWeekStartUtc}`);
  
  // Test: Check which days would be highlighted
  console.log(`   \n   Testing which days get highlighted (checking days around todayDayIndex):`);
  const checkRange = [todayDayIndex - 10, todayDayIndex + 10];
  const highlightedDays = [];
  
  for (let d = checkRange[0]; d <= checkRange[1]; d++) {
    if (d < 0) continue;
    
    // Current logic: calculate week start for day d
    const dDateObj = new Date(baseUtc + d * MS_DAY);
    const dDow = dDateObj.getUTCDay();
    const dWeekStartUtc = Date.UTC(
      dDateObj.getUTCFullYear(),
      dDateObj.getUTCMonth(),
      dDateObj.getUTCDate() - dDow
    );
    
    const isInSameWeek = todayWeekStartUtc === dWeekStartUtc;
    
    if (isInSameWeek) {
      highlightedDays.push({
        dayIndex: d,
        date: dDateObj.toISOString().slice(0, 10),
        weekStart: new Date(dWeekStartUtc).toISOString().slice(0, 10),
      });
    }
  }
  
  console.log(`   Days that would be highlighted: ${highlightedDays.length}`);
  if (highlightedDays.length > 0) {
    console.log(`   First highlighted day: day ${highlightedDays[0].dayIndex} (${highlightedDays[0].date})`);
    const lastDay = highlightedDays[highlightedDays.length - 1];
    console.log(`   Last highlighted day: day ${lastDay.dayIndex} (${lastDay.date})`);
    
    // Check if today is in the highlighted range
    const todayInRange = highlightedDays.some(h => h.dayIndex === todayDayIndex);
    if (!todayInRange) {
      console.log(`   ⚠️  PROBLEM: Today (day ${todayDayIndex}) is NOT in the highlighted range!`);
    }
    
    // Check if we're highlighting too many days (should be max 7 for a week)
    if (highlightedDays.length > 7) {
      console.log(`   ⚠️  PROBLEM: Highlighting ${highlightedDays.length} days (should be max 7 for a week)`);
    }
    
    // Check if we're highlighting days in the wrong month
    const wrongMonthDays = highlightedDays.filter(h => {
      const date = new Date(h.date);
      return date.getUTCMonth() !== TODAY_MONTH || date.getUTCFullYear() !== TODAY_YEAR;
    });
    if (wrongMonthDays.length > 0) {
      console.log(`   ⚠️  PROBLEM: ${wrongMonthDays.length} highlighted days are in the wrong month/year:`);
      wrongMonthDays.forEach(h => {
        console.log(`      - Day ${h.dayIndex}: ${h.date}`);
      });
    }
  } else {
    console.log(`   ⚠️  PROBLEM: No days are being highlighted!`);
  }
  
  // Additional diagnostic: Check what date dayIndex 0 corresponds to
  const day0Date = new Date(baseUtc);
  console.log(`   \n   Day index 0 corresponds to: ${day0Date.toISOString().slice(0, 10)}`);
  
  // Check what the week start calculation gives for a few specific days
  console.log(`   \n   Week start calculations for specific days:`);
  const testDays = [
    { name: "Today", dayIndex: todayDayIndex },
    { name: "Today - 7", dayIndex: todayDayIndex - 7 },
    { name: "Today + 7", dayIndex: todayDayIndex + 7 },
  ];
  
  testDays.forEach(({ name, dayIndex }) => {
    if (dayIndex < 0) return;
    const dDateObj = new Date(baseUtc + dayIndex * MS_DAY);
    const dDow = dDateObj.getUTCDay();
    const dWeekStartUtc = Date.UTC(
      dDateObj.getUTCFullYear(),
      dDateObj.getUTCMonth(),
      dDateObj.getUTCDate() - dDow
    );
    const matches = dWeekStartUtc === todayWeekStartUtc;
    console.log(`     ${name} (day ${dayIndex}, ${dDateObj.toISOString().slice(0, 10)}, dow=${dDow}): week start = ${new Date(dWeekStartUtc).toISOString().slice(0, 10)} ${matches ? '✓ MATCHES' : '✗ different'}`);
  });
});

console.log("\n" + "=".repeat(80));
console.log("TEST SUMMARY");
console.log("=".repeat(80));
console.log("If today (Jan 5) is not being highlighted correctly, check:");
console.log("1. Is todayDayIndex calculated correctly?");
console.log("2. Does baseUtc + todayDayIndex * MS_DAY equal todayUtc?");
console.log("3. Is the week start calculation correct for today?");
console.log("4. Are days in February being incorrectly matched to January's week?");
console.log("5. Is there a timezone issue causing date calculations to be off by a day?");
