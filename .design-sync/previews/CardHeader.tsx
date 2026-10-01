import { Card, CardContent, CardDescription, CardHeader, CardTitle, Label, Input } from '@axiom/ui';

export const Header = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>Register connector</CardTitle>
      <CardDescription>Add a data source so agents can map personal data flows.</CardDescription>
    </CardHeader>
    <CardContent>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        <Label htmlFor="ch1">Endpoint identifier</Label>
        <Input id="ch1" placeholder="crm-prod-mumbai-01" />
      </div>
    </CardContent>
  </Card>
);

export const HeaderOnly = () => (
  <Card style={{ width: 380 }}>
    <CardHeader>
      <CardTitle>DSAR intake</CardTitle>
      <CardDescription>No open data principal requests.</CardDescription>
    </CardHeader>
  </Card>
);
