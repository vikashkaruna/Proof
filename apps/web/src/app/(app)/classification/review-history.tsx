import Link from 'next/link';
import { Badge, Card, CardContent, CardHeader, formatDateTime } from '@axiom/ui';
import type { ClassificationReviewHistory } from '@/lib/classification-reviews';

export function ClassificationReviewHistoryView({
  history,
}: {
  history: ClassificationReviewHistory;
}) {
  return (
    <Card
      className="min-w-0 w-full"
      role="region"
      aria-label="Recorded human classification reviews"
    >
      <CardHeader>
        <h2 className="font-heading text-lg font-semibold text-indigo-700">
          Recorded human classification reviews
        </h2>
        <p className="text-sm text-slate-600">
          These records contain a person&apos;s review decision and declared classification details.
          The original agent observation, source digest and source verification are not recorded.
          They do not prove that a system was scanned or that its classification was corrected.
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {history.state === 'unavailable' ? (
          <p role="alert">Classification review history is unavailable. Refresh to try again.</p>
        ) : history.state === 'invalid_page' ? (
          <p role="alert">
            Choose a review page between 1 and 1000.{' '}
            <Link href="/classification">Open the first page</Link>.
          </p>
        ) : (
          <>
            {history.reviews.length === 0 ? (
              <p>
                {history.page === 1
                  ? 'No human classification reviews recorded.'
                  : 'No human classification reviews on this page.'}
              </p>
            ) : (
              <ol className="space-y-3">
                {history.reviews.map((review) => (
                  <li key={review.id} className="min-w-0 rounded-lg border border-slate-200 p-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="break-all text-sm font-semibold text-indigo-700">
                        {review.system_id} · {review.resource_path}
                      </h3>
                      <Badge variant="neutral">{review.decision}</Badge>
                    </div>
                    <dl className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2 lg:grid-cols-3">
                      <div>
                        <dt className="text-slate-500">Original sensitivity (declared)</dt>
                        <dd className="break-words">{review.sensitivity_level}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Adjusted sensitivity (recorded)</dt>
                        <dd className="break-words">
                          {review.adjusted_sensitivity ?? 'No adjustment recorded'}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Categories (declared)</dt>
                        <dd className="break-words">{review.detected_categories.join(', ')}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Confidence (declared)</dt>
                        <dd>{review.confidence_score}%</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Reviewed by</dt>
                        <dd className="break-all font-mono text-xs">{review.reviewed_by}</dd>
                      </div>
                      <div>
                        <dt className="text-slate-500">Recorded at</dt>
                        <dd>
                          <time dateTime={review.created_at}>
                            {formatDateTime(review.created_at)}
                          </time>
                        </dd>
                      </div>
                    </dl>
                    <p className="mt-3 whitespace-pre-wrap break-words text-sm text-slate-700">
                      {review.justification}
                    </p>
                    <p className="mt-2 break-all font-mono text-xs text-slate-400">
                      Review ID: {review.id}
                    </p>
                  </li>
                ))}
              </ol>
            )}
            <nav
              aria-label="Classification review pages"
              className="flex flex-wrap items-center gap-4 text-sm"
            >
              {history.page > 1 && (
                <Link
                  href={`/classification?reviewPage=${history.page - 1}`}
                  className="text-teal-700 underline"
                >
                  Newer reviews
                </Link>
              )}
              <span>Page {history.page} · up to 50 records per page</span>
              {history.hasNext && history.page < 1000 && (
                <Link
                  href={`/classification?reviewPage=${history.page + 1}`}
                  className="text-teal-700 underline"
                >
                  Older reviews
                </Link>
              )}
            </nav>
          </>
        )}
      </CardContent>
    </Card>
  );
}
