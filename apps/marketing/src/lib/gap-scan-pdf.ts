import { BRAND } from '@axiom/config';
import { CONTROL_LIBRARY_COUNT } from '@axiom/control-library';
import type { GapScanStoredReport } from '@axiom/types';
import type { jsPDF } from 'jspdf';

// Presentation only: scores, findings and roadmap are the stored server assessment.
// Fonts are bundled locally; report content never leaves the browser for rendering.
export async function createGapScanPdf(scan: GapScanStoredReport): Promise<jsPDF> {
  const { jsPDF } = await import('jspdf');
  const doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
  for (const [file, style] of [
    ['NotoSans-Regular.ttf', 'normal'],
    ['NotoSans-Bold.ttf', 'bold'],
  ] as const) {
    const response = await fetch(`/fonts/${file}`, { credentials: 'same-origin' });
    if (!response.ok) throw new Error('The report font could not be loaded. Please try again.');
    const bytes = new Uint8Array(await response.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 8192)
      binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    doc.addFileToVFS(file, btoa(binary));
    doc.addFont(file, 'NotoSans', style);
  }
  const companyLogoResponse = await fetch('/brand/axiom-minds-company.png', {
    credentials: 'same-origin',
  });
  if (!companyLogoResponse.ok)
    throw new Error('The company logo could not be loaded. Please try again.');
  const companyLogo = new Uint8Array(await companyLogoResponse.arrayBuffer());
  const indigo = '#1E2A4A';
  const teal = '#0FB5A5';
  const slate = '#475569';
  const report = scan.report_snapshot;
  const clean = (value: string) => value.replace(/[\u0000-\u001F\u007F]/g, ' ').trim();
  let y = 36;
  const font = (size = 10, bold = false, color = slate) => {
    doc.setFont('NotoSans', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    doc.setTextColor(color);
  };
  const logo = (x: number, top: number, size: number) => {
    doc.setFillColor(teal);
    doc.roundedRect(x, top, size, size, size / 4, size / 4, 'F');
    doc.setDrawColor('#FFFFFF');
    doc.setLineWidth((size * 2.2) / 34);
    doc.circle(x + size / 2, top + size / 2, (size * 7.5) / 34, 'S');
    doc.line(
      x + (size * 13.5) / 34,
      top + (size * 17.3) / 34,
      x + (size * 16.2) / 34,
      top + (size * 20) / 34,
    );
    doc.line(
      x + (size * 16.2) / 34,
      top + (size * 20) / 34,
      x + (size * 21) / 34,
      top + (size * 14.6) / 34,
    );
  };
  const header = () => {
    logo(17, 12, 11);
    font(14, true, indigo);
    doc.text('AXIOM PROOF', 32, 17);
    font(8);
    doc.text('by Axiom Minds', 32, 22);
    font(8, false, indigo);
    doc.text('DPDPA READINESS ASSESSMENT', 193, 17, { align: 'right' });
    doc.setDrawColor('#CBD5E1');
    doc.setLineWidth(0.25);
    doc.line(17, 28, 193, 28);
  };
  const ensure = (height: number) => {
    if (y + height > 267) {
      doc.addPage();
      header();
      y = 36;
    }
  };
  const text = (value: string, size = 10, bold = false, color = slate) => {
    font(size, bold, color);
    const lines = doc.splitTextToSize(clean(value), 176) as string[];
    const lineHeight = size * 0.48;
    for (const line of lines) {
      ensure(lineHeight);
      font(size, bold, color);
      doc.text(line, 17, y);
      y += lineHeight;
    }
    y += 2;
  };
  const section = (title: string) => {
    ensure(22);
    y += 4;
    text(title, 13, true, indigo);
  };
  header();
  doc.setProperties({
    title: `${BRAND.name} — DPDPA Readiness Report`,
    author: BRAND.company,
    subject: 'Statutory Gap-Scan Assessment',
    creator: BRAND.name,
  });
  text('Your DPDPA Readiness Report', 22, true, indigo);
  text('Statutory Gap-Scan Assessment', 11, true, teal);
  if (scan.contact_company) text(`Prepared for: ${scan.contact_company}`, 11, true);
  text(
    `Assessment date: ${new Date(scan.created_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST`,
    9,
  );
  text(
    `${report.findings.length} selected controls assessed from the ${CONTROL_LIBRARY_COUNT}-control library v${scan.library_version}.`,
    9,
  );
  section('Executive summary');
  text(`Readiness score: ${Number(scan.posture_score).toFixed(0)} / 100`, 18, true, indigo);
  text(
    `Indicative statutory exposure: INR ${Number(scan.estimated_exposure_inr).toLocaleString('en-IN')}`,
    11,
    true,
  );
  text(
    'This is a self-assessment based on the answers supplied. Controls have not been independently verified. A 5% global discount is applied to unverified self-attestation. The score and exposure estimate are indicators, not a certification of legal compliance or a prediction of penalties.',
    9,
  );
  section('Priority remediation plan');
  for (const item of report.recommendations) {
    ensure(25);
    text(`${item.priority}. ${item.title}`, 11, true, indigo);
    text(`Estimated effort: ${item.effort}`, 9);
  }
  section(`Detailed control findings (${report.findings.length})`);
  for (const finding of report.findings) {
    ensure(40);
    text(`${finding.controlId} — ${finding.title}`, 11, true, indigo);
    text(
      `Severity: ${finding.severity.toUpperCase()}   |   Score: ${Number(finding.score).toFixed(0)} / 100   |   Risk points: ${Number(finding.riskPoints).toFixed(1)}`,
      9,
    );
    text(
      `Assessment status: ${finding.score >= 80 ? 'Compliant (self-assessed)' : finding.score >= 40 ? 'Partial' : 'Gap'}`,
      9,
      true,
      finding.score < 40 ? '#D9534F' : slate,
    );
    text(finding.rationale, 9);
    y += 2;
  }
  const index = report.readinessIndex;
  if (index) {
    section(`Indicative sector benchmark — ${index.sector}`);
    text(
      'Sector benchmarks and standing are Axiom editorial estimates, not measured peer-organisation data. They provide context and are not a verified ranking.',
      9,
    );
    text(
      `Your score: ${index.companyScore} / 100   |   Sector benchmark: ${index.sectorBenchmarkScore} / 100   |   Indicative standing: top ${100 - index.percentileRank}%`,
      10,
    );
    text(
      `Status: ${index.status.replaceAll('_', ' ')}   |   Statutory risk weight: ${index.exposureMultiplier}x exposure`,
      9,
    );
    section('Sector risk factors');
    index.sectorTopRisks.forEach((risk, i) => text(`${i + 1}. ${risk}`, 9));
    section('Quarterly readiness roadmap');
    for (const quarter of index.quarterlyRoadmap) {
      ensure(30);
      text(`${quarter.quarter} — target ${quarter.targetScore} / 100`, 10, true, indigo);
      text(quarter.milestone, 9);
      text(`Statutory gate: ${quarter.statutoryDeadline}`, 9);
    }
  }
  section('Scope, interpretation and next steps');
  text(
    'This report covers only the selected controls and the assessment snapshot identified below. Findings are based on supplied answers; no technical audit, evidence verification or legal opinion is implied. Use the remediation priorities to plan evidence collection and a qualified review of applicable obligations.',
    9,
  );
  text(
    'Keep this report private and share it only with authorised recipients. Downloading a PDF does not send an email or publish the report.',
    9,
  );
  const pages = doc.getNumberOfPages();
  for (let page = 1; page <= pages; page++) {
    doc.setPage(page);
    doc.setDrawColor('#CBD5E1');
    doc.line(17, 274, 193, 274);
    doc.addImage(companyLogo, 'PNG', 17, 277, 6, 6);
    font(8, true, indigo);
    doc.text(BRAND.company, 26, 280);
    font(7);
    doc.text(`axiomproof.ai  |  ${BRAND.companyDomain}`, 26, 285);
    doc.text(BRAND.contactEmail, 193, 280, { align: 'right' });
    doc.text(BRAND.contactPhone, 193, 285, { align: 'right' });
    font(7);
    doc.text(`Report ${scan.id}  |  Library v${scan.library_version}`, 17, 291);
    doc.text(`${page} / ${pages}`, 193, 291, { align: 'right' });
  }
  return doc;
}
