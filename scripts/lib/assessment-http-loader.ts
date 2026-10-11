/** Root harness files run as CommonJS under tsx; BFF runs as ESM. Compose
 * both HTTP modules through the same ESM loader so private refusal constructors
 * retain identity across the real producer/route boundary. */
export async function loadAssessmentHttpModules() {
  const producer = await import('../../services/bff/src/workloads/assessment-producer.js');
  const application = await import('../../services/bff/src/app.js');
  return { producer, application };
}
