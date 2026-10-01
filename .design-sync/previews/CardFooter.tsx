import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@axiom/ui';

export const Actions = () => (
  <Card style={{ width: 400 }}>
    <CardHeader>
      <CardTitle>Erasure remediation</CardTitle>
      <CardDescription>Dry-run complete and rollback validated.</CardDescription>
    </CardHeader>
    <CardFooter>
      <Button variant="primary" size="sm">
        Approve
      </Button>
      <Button variant="ghost" size="sm" style={{ marginLeft: 8 }}>
        Reject
      </Button>
    </CardFooter>
  </Card>
);

export const WithContent = () => (
  <Card style={{ width: 400 }}>
    <CardHeader>
      <CardTitle>Register connector</CardTitle>
      <CardDescription>Endpoint crm-prod-mumbai-01</CardDescription>
    </CardHeader>
    <CardContent>
      <p style={{ margin: 0, fontSize: 14 }}>
        Agents will map personal data fields after registration.
      </p>
    </CardContent>
    <CardFooter>
      <Button variant="primary" size="sm">
        Register
      </Button>
      <Button variant="ghost" size="sm" style={{ marginLeft: 8 }}>
        Cancel
      </Button>
    </CardFooter>
  </Card>
);
