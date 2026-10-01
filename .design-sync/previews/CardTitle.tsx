import { Card, CardDescription, CardHeader, CardTitle } from '@axiom/ui';

export const Title = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Evidence vault retention</CardTitle>
      <CardDescription>Sealed objects keep their recorded retention period.</CardDescription>
    </CardHeader>
  </Card>
);

export const LongTitle = () => (
  <Card style={{ width: 300 }}>
    <CardHeader>
      <CardTitle>Cross-border transfer assessment for processor onboarding</CardTitle>
      <CardDescription>Awaiting reviewer.</CardDescription>
    </CardHeader>
  </Card>
);
