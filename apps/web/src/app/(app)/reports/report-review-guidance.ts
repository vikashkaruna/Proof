type RequestStatus = 'requested' | 'drafted' | 'reviewed' | 'released' | 'rejected';
export function requestReviewGuidance(status: RequestStatus): string {
  switch (status) {
    case 'requested':
      return 'Generate the draft from this saved request.';
    case 'drafted':
      return 'Open the exact draft and record its review decision.';
    case 'reviewed':
      return 'Build or inspect retained artifacts, then preview the exact PDF before release.';
    case 'released':
      return 'Read or download the original released PDF.';
    case 'rejected':
      return 'Preserve the rejected history; no release is available for this request.';
  }
}
