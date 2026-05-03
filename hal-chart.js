/**
 * hal-chart.js — Chart spec generator for Hal Chat UI.
 *
 * Pure function — no database, no async. Validates and structures
 * chart data for rendering by the ChartArtifact component in hal-chat-ui.
 *
 * Exports: generateChart
 */

const VALID_TYPES = new Set(['line', 'bar', 'pie']);

/**
 * Generate a chart spec for the Chat UI to render.
 *
 * @param {object} params
 * @param {'line'|'bar'|'pie'} params.chart_type
 * @param {string} params.title
 * @param {string} [params.description]
 * @param {string} [params.x_label]
 * @param {string} [params.y_label]
 * @param {string[]} [params.series]
 * @param {Array<Record<string, unknown>>} params.data
 * @returns {{ success: true, chart_spec: true, chart_type, title, description, x_label, y_label, series, data }
 *          | { success: false, exit_reason: 'validation_error', message: string }}
 */
export function generateChart({ chart_type, title, description, x_label, y_label, series, data }) {
  if (!VALID_TYPES.has(chart_type)) {
    return { success: false, exit_reason: 'validation_error', message: `Invalid chart_type: ${chart_type}` };
  }

  if (!Array.isArray(data) || data.length === 0) {
    return { success: false, exit_reason: 'validation_error', message: 'data array is required and must not be empty' };
  }

  if (data.length > 200) {
    return { success: false, exit_reason: 'validation_error', message: 'data array exceeds maximum of 200 points' };
  }

  if (chart_type === 'pie' && data.length > 6) {
    console.warn('hal-chart: pie chart has more than 6 segments — consider using bar chart instead');
  }

  if (series && series.length > 0) {
    for (const point of data) {
      for (const s of series) {
        if (!(s in point)) {
          return {
            success: false,
            exit_reason: 'validation_error',
            message: `Data point missing key "${s}" required by series definition`,
          };
        }
      }
    }
  }

  return {
    success: true,
    chart_spec: true,
    chart_type,
    title,
    description: description ?? null,
    x_label: x_label ?? null,
    y_label: y_label ?? null,
    series: series ?? null,
    data,
  };
}