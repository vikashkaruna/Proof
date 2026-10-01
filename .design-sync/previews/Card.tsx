import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@axiom/ui';

export const ActionCard = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Retention and erasure remediation</CardTitle>
      <CardDescription>
        Recorded action awaiting human review. Open the plan to inspect the dry-run, rollback and
        scope before approving.
      </CardDescription>
    </CardHeader>
    <CardContent>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <Badge variant="warning">Awaiting approval</Badge>
        <Badge variant="neutral">Recorded risk: medium</Badge>
      </div>
    </CardContent>
    <CardFooter>
      <Button variant="primary" size="sm">
        Review plan
      </Button>
      <Button variant="ghost" size="sm" style={{ marginLeft: 8 }}>
        Not now
      </Button>
    </CardFooter>
  </Card>
);

export const EmptyState = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Approval queue</CardTitle>
      <CardDescription>No recorded actions await approval.</CardDescription>
    </CardHeader>
  </Card>
);
