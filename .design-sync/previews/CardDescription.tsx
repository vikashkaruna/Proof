import { Card, CardDescription, CardHeader, CardTitle } from '@axiom/ui';

export const Description = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Approval queue</CardTitle>
      <CardDescription>
        Each recorded action needs a completed dry-run and a validated rollback before it can be
        approved.
      </CardDescription>
    </CardHeader>
  </Card>
);

export const ShortDescription = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Consent notices</CardTitle>
      <CardDescription>4 versions published.</CardDescription>
    </CardHeader>
  </Card>
);
