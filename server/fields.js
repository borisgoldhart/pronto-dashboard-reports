/**
 * Captured legacy report-builder metadata (see docs/legacy-report-fields.md).
 * These are the exact values the legacy tool sends to the Reporting API.
 */

// Data Source -> Solr core/entity. All cores confirmed by live probe 2026-07-16
// (search: job, asset, ticket · report: user_history, timesheet_user_data,
// asset_download, form_data, finance_document).
// `officeField` = the office dimension to filter on for this source. Timesheet/usage
// are attributed to the user's office (author_office_name); jobs/assets to the
// project's office (client_office_name) — matching the board-report conventions.
export const DATA_SOURCES = {
  user_history: { core: "report", entity: "user_history", label: "User History", defaultStatsField: "time", officeField: "author_office_name" },
  timesheet_user_data: { core: "report", entity: "timesheet_user_data", label: "Timesheet Data", defaultStatsField: "hours", officeField: "author_office_name" },
  job: { core: "search", entity: "job", label: "Jobs Data", defaultStatsField: null, officeField: "client_office_name" },
  asset: { core: "search", entity: "asset", label: "Assets Data", defaultStatsField: null, officeField: "client_office_name" },
  ticket: { core: "search", entity: "ticket", label: "Tickets Data", defaultStatsField: null, officeField: "client_office_name" },
  asset_download: { core: "report", entity: "asset_download", label: "Asset Downloads", defaultStatsField: "download_count", officeField: "author_office_name" },
  form_data: { core: "report", entity: "form_data", label: "Form Data", defaultStatsField: null, officeField: "author_office_name" },
  finance_document: { core: "report", entity: "finance_document", label: "Finance Document", defaultStatsField: null, officeField: "client_office_name" },
};

export function officeFieldFor(dataSource) {
  return (resolveDataSource(dataSource) || {}).officeField || "client_office_name";
}

// Display Data As -> Solr stats result. `count` reads bucket.count; the rest need a stats field.
export const DISPLAY_AS = {
  count: { statsResult: null, bucketField: "count", label: "Count" },
  sum: { statsResult: "stats_field_sum", bucketField: "stats_field_sum", label: "Sum" },
  min: { statsResult: "stats_field_min", bucketField: "stats_field_min", label: "Min" },
  max: { statsResult: "stats_field_max", bucketField: "stats_field_max", label: "Max" },
  mean: { statsResult: "stats_field_mean", bucketField: "stats_field_mean", label: "Mean" },
  stddev: { statsResult: "stats_field_stddev", bucketField: "stats_field_stddev", label: "Standard Deviation" },
};

// Interval value -> API `gap`.
export const INTERVALS = {
  "0": { gap: "0", label: "No interval" },
  "1DAY": { gap: "+1DAY", label: "Day" },
  "7DAYS": { gap: "+7DAYS", label: "Week" },
  "1MONTH": { gap: "+1MONTH", label: "Month" },
  "1YEAR": { gap: "+1YEAR", label: "Year" },
};

export const CHART_TYPES = ["bar", "stacked", "line", "pie", "donut", "semi-circle"];
export const PIVOT_BY = { group: "Group", subgroup: "Sub Group" };
export const LABEL_ROTATION = { "270": "Vertical", "0": "Horizontal", "335": "Angle" };
// NB "Last 2 Months" is the default preset for a new widget and has always been
// resolvable by the client — it was just missing from this list, so the editor
// fell back to showing "Custom Dates" for a window that was in fact still
// rolling daily. Listed now so what the dropdown says matches what runs.
export const DATE_PRESETS = ["This Week", "Last 7 Days", "This Month", "Last Month", "Last 2 Months", "Last 3 Months", "YTD", "Last Year", "Custom Dates"];

// The shared 96-field list (GROUP BY / SUBGROUP / FILTER). "value|label", deduped by value.
const FIELD_LINES = `
adaptation_count|Adaptation Count
agresso_bill_currency|Agresso Bill Currency
agresso_branch|Agresso Branch
agresso_customer_po|Agresso Customer PO
agresso_inv_rule|Agresso Invoice Rule
agresso_proj_type|Agresso Project Type
agresso_start_ts_from|Agresso Start Timesheets_From
agresso_tax_code|Agresso Tax Code
asset_archive|Archive
asset_airing_country|Asset Airing Country
asset_airing_country_name|Asset Airing Country Name
mine_call_to_action|Asset Call To Action
asset_portfolio_name|Asset Campaign Name
asset_category|Asset Category
asset_id|Asset ID
asset_market_iso|Asset Market ISO
asset_market_name|Asset Market Name
mine_product|Asset Product
asset_purpose|Asset Purpose
mine_range|Asset Range
asset_size|Asset Size
linked_assets_adaptation_source_ids|Asset Source Asset Ids (Adaptations)
asset_status|Asset Status
asset_title|Asset Title
brandcat_id|Brand Category ID
brandcat_name|Brand Category Name
mine_brand_code|Brand Code
brand_id|Brand ID
brand_name|Brand Name
asset_business_line|Business Line
mine_channel_code|Channel Code
mine_channel_name|Channel Name
customfieldid|Custom Field ID
download_count|Download Count
download_client_country|Downloader User Client Country
download_clientid|Downloader User Client ID
download_userid|Downloader User ID
download_user_name|Downloader User Name
form_id|Form ID
form_name|Form Name
form_data|Form Values
invoice_status|Invoice Status
invoice_finance_type|Invoice Type
job_airing_country_iso|Job Airing Country ISO
job_airing_country_name|Job Airing Country Name
job_airing_region_name|Job Airing Region Name
portfolio_id|Job Campaign ID
portfolio_name|Job Campaign Name
job_extension|Job Extension Number
jobid|Job ID
client_office_country_iso|Job Office Country ISO
client_id|Job Office ID
client_office_name|Job Office Name
job_status|Job Status
timesheet_job_total_hours|Job Timesheet Total Hours
language_iso|Language ISO
language_name|Language Name
mine_asset_format_code|Mine Asset Format Code
mine_asset_format|Mine Asset Format Name
mine_asset_name|Mine Asset Name
mine_asset_origin|Mine Asset Origin
mine_category_code|Mine Category Code
mine_category_name|Mine Category Name
mine_dimension_value|Mine Dimension
url|Page URL
mine_program_code|Program Code
mine_program_name|Program Name
job_title|Project Name
project_type_name|Project Type Name
_text_|Search
tag_vals|Tags
task_assigned_users|Task Assigned User
ticket_id|Task ID
ticket_status_name|Task Status
period|Time
timesheetactivityid|Timesheet Activity Id
timesheet_activity_name|Timesheet Activity Name
timesheet_date_entered|Timesheet Date Entered
timesheet_entered_by|Timesheet Entered By
hours|Timesheet Hours
timesheet_rate|Timesheet Rate
timesheet_rate_currency|Timesheet Rate Currency
timesheet_status|Timesheet Status
user_department|Timesheet User Department
user_income_category|Timesheet User Income Role
user_role|Timesheet User Role
time|Upload Date
user_category_role|User Category Role
author_id|User ID
author_name|User Name
author_office_id|User Office ID
author_office_name|User Office Name
type|type
`.trim();

const _seen = new Set();
export const FIELDS = FIELD_LINES.split("\n").map((l) => {
  const [value, label] = l.split("|");
  return { value: value.trim(), label: label.trim() };
}).filter((f) => (_seen.has(f.value) ? false : _seen.add(f.value)));

export const FIELD_SET = new Set(FIELDS.map((f) => f.value));

// ---- Backward-compat aliases (old Phase-2 short keys -> real values) ----
export const DATA_SOURCE_ALIASES = {
  usage: "user_history", timesheets: "timesheet_user_data", jobs: "job", assets: "asset",
};
export const GROUP_BY_ALIASES = {
  client_office: "client_office_name", master_client: "brandcat_name",
  author_office: "author_office_name", author: "author_name", job: "jobid",
};
export const INTERVAL_ALIASES = {
  day: "1DAY", week: "7DAYS", month: "1MONTH", year: "1YEAR", half: "1YEAR", quarter: "1MONTH",
};

export function resolveDataSource(v) {
  return DATA_SOURCES[v] || DATA_SOURCES[DATA_SOURCE_ALIASES[v]] || null;
}
export function resolveField(v) {
  if (FIELD_SET.has(v)) return v;
  return GROUP_BY_ALIASES[v] || v; // pass through raw field names
}
export function resolveGap(v) {
  if (v && v.startsWith("+")) return v; // already an API gap
  const key = INTERVALS[v] ? v : INTERVAL_ALIASES[v];
  return key && INTERVALS[key] ? INTERVALS[key].gap : "+1MONTH";
}
