import { EngagementStatus, MilestoneKind, MilestoneStatus, UserRole } from '@prisma/client';
import { GraphqlResolver } from '../graphql.resolver';
import { createGraphqlLoaders, GraphqlContext } from '../loaders/graphql-loaders';
import { EngagementFieldsResolver } from './engagement-fields.resolver';

const ENGAGEMENT_COUNT = 50;

function makeUser(stellarAddress: string, role: UserRole) {
  return {
    id: `user-${stellarAddress}`,
    stellarAddress,
    name: stellarAddress,
    company: role === UserRole.COMPANY ? `Company ${stellarAddress}` : null,
    role,
    verifiedAt: null,
  };
}

function makeEngagement(i: number) {
  return {
    id: `eng-${i}`,
    // 10 companies, 5 recruiters, 1 arbiter shared across 50 engagements.
    companyAddress: `GCOMPANY${i % 10}`,
    recruiterAddress: `GRECRUITER${i % 5}`,
    arbiterAddress: 'GARBITER',
    tokenAddress: 'CUSDC',
    totalAmount: BigInt(1_000_000 + i),
    releasedAmount: BigInt(0),
    jobTitle: `Role ${i}`,
    jobDescription: null,
    salaryRange: null,
    location: null,
    status: EngagementStatus.ACTIVE,
    createdAt: new Date('2026-10-01T00:00:00Z'),
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  };
}

function makeMilestones(engagementId: string) {
  return [0, 1].map((milestoneIndex) => ({
    id: `${engagementId}-m${milestoneIndex}`,
    engagementId,
    milestoneIndex,
    name: `Milestone ${milestoneIndex}`,
    kind: MilestoneKind.PLACEMENT,
    paymentPercent: 50,
    amount: BigInt(500_000),
    status: MilestoneStatus.PENDING,
    proofHash: null,
    confirmedAt: null,
  }));
}

function makePrisma() {
  const engagements = Array.from({ length: ENGAGEMENT_COUNT }, (_, i) => makeEngagement(i));
  const users = [
    ...Array.from({ length: 10 }, (_, i) => makeUser(`GCOMPANY${i}`, UserRole.COMPANY)),
    ...Array.from({ length: 5 }, (_, i) => makeUser(`GRECRUITER${i}`, UserRole.RECRUITER)),
    makeUser('GARBITER', UserRole.ARBITER),
  ];
  const milestones = engagements.flatMap((e) => makeMilestones(e.id));

  return {
    engagement: {
      findMany: jest.fn(async () => engagements),
      findUnique: jest.fn(),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        users.filter((u) => where.stellarAddress.in.includes(u.stellarAddress)),
      ),
    },
    milestone: {
      findMany: jest.fn(async ({ where }: any) =>
        milestones.filter((m) => where.engagementId.in.includes(m.engagementId)),
      ),
    },
  };
}

function totalQueries(prisma: ReturnType<typeof makePrisma>) {
  return (
    prisma.engagement.findMany.mock.calls.length +
    prisma.user.findMany.mock.calls.length +
    prisma.milestone.findMany.mock.calls.length
  );
}

/**
 * Mimic graphql-js: resolve the root list, then every relation field of every
 * item in the same execution phase.
 */
async function resolveEngagementList(prisma: ReturnType<typeof makePrisma>) {
  const ctx: GraphqlContext = { loaders: createGraphqlLoaders(prisma as any) };
  const root = new GraphqlResolver(prisma as any);
  const fields = new EngagementFieldsResolver();

  const engagements = await root.engagements(undefined, 0, ENGAGEMENT_COUNT);
  return Promise.all(
    engagements.map(async (engagement) => {
      const [company, recruiter, arbiter, milestones] = await Promise.all([
        fields.company(engagement, ctx),
        fields.recruiter(engagement, ctx),
        fields.arbiter(engagement, ctx),
        fields.milestones(engagement, ctx),
      ]);
      return { ...engagement, company, recruiter, arbiter, milestones };
    }),
  );
}

describe('EngagementFieldsResolver DataLoaders (#515)', () => {
  it('resolves 50 engagements with all relations in a constant number of queries', async () => {
    const prisma = makePrisma();

    const result = await resolveEngagementList(prisma);

    expect(result).toHaveLength(ENGAGEMENT_COUNT);
    // 1 engagements + 1 companies + 1 users (recruiters + arbiter) + 1 milestones
    expect(prisma.engagement.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.milestone.findMany).toHaveBeenCalledTimes(1);
    expect(totalQueries(prisma)).toBe(4);
  });

  it('keeps the query count flat regardless of list size', async () => {
    const small = makePrisma();
    small.engagement.findMany.mockImplementation(async () =>
      Array.from({ length: 2 }, (_, i) => makeEngagement(i)),
    );
    await resolveEngagementList(small);

    const large = makePrisma();
    await resolveEngagementList(large);

    expect(totalQueries(small)).toBe(totalQueries(large));
  });

  it('requests each distinct key once per batch', async () => {
    const prisma = makePrisma();

    await resolveEngagementList(prisma);

    const userBatches = prisma.user.findMany.mock.calls.map(
      ([args]: any) => args.where.stellarAddress.in as string[],
    );
    const companyBatch = userBatches.find((keys) => keys[0].startsWith('GCOMPANY'));
    const userBatch = userBatches.find((keys) => !keys[0].startsWith('GCOMPANY'));
    expect(companyBatch).toHaveLength(10);
    expect(userBatch).toHaveLength(6); // 5 recruiters + 1 arbiter
    expect(new Set(userBatch!).size).toBe(userBatch!.length);

    const milestoneBatch = (prisma.milestone.findMany.mock.calls[0] as any)[0].where.engagementId.in;
    expect(milestoneBatch).toHaveLength(ENGAGEMENT_COUNT);
  });

  it('maps every relation back to the correct engagement', async () => {
    const prisma = makePrisma();

    const result = await resolveEngagementList(prisma);

    for (const engagement of result) {
      expect(engagement.company!.stellarAddress).toBe(engagement.companyAddress);
      expect(engagement.recruiter!.stellarAddress).toBe(engagement.recruiterAddress);
      expect(engagement.arbiter!.stellarAddress).toBe('GARBITER');
      expect(engagement.milestones.map((m) => m.milestoneIndex)).toEqual([0, 1]);
      expect(engagement.milestones.every((m) => m.id.startsWith(`${engagement.id}-`))).toBe(true);
      expect(engagement.milestones[0].amount).toBe('500000');
    }
    expect(result[0].totalAmount).toBe('1000000');
  });

  it('does not share cached data between requests', async () => {
    const prisma = makePrisma();

    await resolveEngagementList(prisma);
    await resolveEngagementList(prisma);

    // Each request builds its own loaders, so it hits the database again.
    expect(prisma.user.findMany).toHaveBeenCalledTimes(4);
    expect(prisma.milestone.findMany).toHaveBeenCalledTimes(2);
  });
});
