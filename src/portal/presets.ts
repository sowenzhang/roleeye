/**
 * Presets that replace free-text configuration.
 *
 * Asking someone to type "engineer, architect, staff, principal" into four
 * comma-separated boxes is asking them to guess our matching rules. These
 * presets encode the same intent as pickable options, and still compile down to
 * exactly the scope and criteria the CLI already validates.
 *
 * The generated values remain visible and editable under Advanced, so nothing
 * here removes capability — it removes typing.
 */

export interface RoleFamily {
  id: string;
  label: string;
  hint: string;
  titles: string[];
  /** Titles that superficially match but are a different job. */
  excludes: string[];
}

export const ROLE_FAMILIES: readonly RoleFamily[] = [
  {
    id: 'software',
    label: 'Software engineering',
    hint: 'backend, frontend, full stack',
    titles: ['software engineer', 'engineer', 'developer', 'swe'],
    excludes: ['sales engineer', 'solutions engineer', 'support engineer', 'customer engineer'],
  },
  {
    id: 'ai',
    label: 'AI and machine learning',
    hint: 'research, applied, MLE',
    titles: ['machine learning', 'ml engineer', 'ai engineer', 'research engineer', 'applied scientist'],
    excludes: ['sales', 'marketing'],
  },
  {
    id: 'data',
    label: 'Data',
    hint: 'data engineering, analytics engineering',
    titles: ['data engineer', 'analytics engineer', 'data platform', 'data scientist'],
    excludes: ['data entry'],
  },
  {
    id: 'infra',
    label: 'Infrastructure and platform',
    hint: 'SRE, platform, cloud',
    titles: ['infrastructure', 'platform engineer', 'site reliability', 'sre', 'devops', 'cloud engineer'],
    excludes: [],
  },
  {
    id: 'security',
    label: 'Security',
    hint: 'appsec, detection, product security',
    titles: ['security engineer', 'security', 'appsec', 'application security'],
    excludes: ['security guard', 'physical security'],
  },
  {
    id: 'mobile',
    label: 'Mobile',
    hint: 'iOS, Android',
    titles: ['ios', 'android', 'mobile engineer'],
    excludes: [],
  },
  {
    id: 'architect',
    label: 'Architecture',
    hint: 'technical architecture, systems design',
    titles: ['architect', 'technical architect', 'solutions architect'],
    excludes: ['landscape architect'],
  },
  {
    id: 'product',
    label: 'Product management',
    hint: 'PM, technical PM',
    titles: ['product manager', 'technical product manager', 'group product manager'],
    excludes: ['product marketing', 'product support'],
  },
  {
    id: 'design',
    label: 'Design',
    hint: 'product design, UX',
    titles: ['product designer', 'ux designer', 'design engineer', 'ux researcher'],
    excludes: ['graphic designer'],
  },
  {
    id: 'em',
    label: 'Engineering management',
    hint: 'EM, director, head of engineering',
    titles: ['engineering manager', 'director of engineering', 'head of engineering', 'vp engineering'],
    excludes: [],
  },
];

export interface SeniorityOption {
  id: string;
  label: string;
  /** Levels as produced by `extractLevel`. */
  levels: string[];
}

export const SENIORITY_OPTIONS: readonly SeniorityOption[] = [
  { id: 'junior', label: 'Junior', levels: ['junior', 'ii', 'iii'] },
  { id: 'mid', label: 'Mid', levels: ['iv'] },
  { id: 'senior', label: 'Senior', levels: ['senior'] },
  { id: 'staff', label: 'Staff', levels: ['staff', 'senior-staff', 'lead'] },
  { id: 'principal', label: 'Principal', levels: ['principal', 'distinguished', 'fellow'] },
  { id: 'manager', label: 'Manager', levels: ['manager', 'senior-manager'] },
  { id: 'director', label: 'Director and above', levels: ['director', 'senior-director', 'vp', 'executive'] },
];

export interface LocationOption {
  id: string;
  label: string;
  countries: string[];
  metros?: string[];
}

export const LOCATION_OPTIONS: readonly LocationOption[] = [
  { id: 'us', label: 'United States', countries: ['US'] },
  { id: 'ca', label: 'Canada', countries: ['CA'] },
  { id: 'uk', label: 'United Kingdom', countries: ['GB'] },
  { id: 'de', label: 'Germany', countries: ['DE'] },
  { id: 'eu-remote', label: 'Ireland and Netherlands', countries: ['IE', 'NL'] },
  { id: 'in', label: 'India', countries: ['IN'] },
];

export const METRO_OPTIONS: readonly string[] = [
  'seattle',
  'san francisco',
  'new york',
  'austin',
  'boston',
  'chicago',
  'los angeles',
  'denver',
  'atlanta',
  'toronto',
  'london',
  'berlin',
];

export const SALARY_STEPS: readonly number[] = [0, 120_000, 150_000, 175_000, 200_000, 225_000, 250_000, 300_000, 400_000];

export interface ApplicationSystemOption {
  id: string;
  label: string;
  hint: string;
}

export const APPLICATION_SYSTEMS: readonly ApplicationSystemOption[] = [
  { id: 'workday', label: 'Workday', hint: 'long multi-page forms' },
  { id: 'taleo', label: 'Taleo', hint: 'dated, account required' },
  { id: 'icims', label: 'iCIMS', hint: 'account required' },
  { id: 'jobvite', label: 'Jobvite', hint: '' },
  { id: 'smartrecruiters', label: 'SmartRecruiters', hint: '' },
];

export interface PresetSelection {
  families: string[];
  seniority: string[];
  locations: string[];
  metros: string[];
  remoteOnly: boolean;
  postedWithinDays: number | undefined;
  salaryFloor: number;
  refuseSystems: string[];
  rejectRelocation: boolean;
  screeningEnabled: boolean;
  captureMode: 'scoped' | 'full' | 'history';
  /**
   * Which companies to watch, as a rule.
   *
   * Replaces the list of catalog entries this used to carry. A list was a
   * snapshot of the catalog on the day it was saved; a rule keeps matching as
   * the catalog grows, and only the companies the user singled out by hand end
   * up named anywhere.
   */
  companySize?: string[];
  companyOwnership?: string[];
  companySectors?: string[];
  /** Watched whatever the rule says, as `type:token`. */
  companyInclude?: string[];
  /** Never watched, even when the rule matches. */
  companyExclude?: string[];
  /** Boards added by URL, which no catalog rule can describe. */
  customBoards?: Array<Record<string, unknown>>;
  /** Free-text additions from the Advanced panel. */
  extraTitles: string[];
  extraExcludes: string[];
}

export interface CompiledConfig {
  scope: Record<string, unknown>;
  hardFilters: Record<string, unknown>;
  preferences: Record<string, unknown>;
}

/**
 * Turns picked options into the scope and criteria the loader validates.
 *
 * Seniority is expressed as an exclusion of unpicked levels rather than an
 * inclusion of picked ones: an inclusion list drops every posting whose title
 * states no level at all, which is a large share of real postings.
 */
export function compileSelection(selection: PresetSelection): CompiledConfig {
  const families = ROLE_FAMILIES.filter((family) => selection.families.includes(family.id));

  const titles = [...new Set([...families.flatMap((family) => family.titles), ...selection.extraTitles])];
  const excludes = [...new Set([...families.flatMap((family) => family.excludes), ...selection.extraExcludes])];

  const pickedLevels = new Set(
    SENIORITY_OPTIONS.filter((option) => selection.seniority.includes(option.id)).flatMap((option) => option.levels),
  );
  const excludedLevels =
    selection.seniority.length === 0
      ? []
      : SENIORITY_OPTIONS.flatMap((option) => option.levels).filter((level) => !pickedLevels.has(level));

  const countries = [
    ...new Set(
      LOCATION_OPTIONS.filter((option) => selection.locations.includes(option.id)).flatMap(
        (option) => option.countries,
      ),
    ),
  ];

  const scope: Record<string, unknown> = {
    titles: { include: titles, exclude: excludes },
    levels: { exclude: excludedLevels },
    locations: {
      countries,
      metros: selection.metros,
      remote_only: selection.remoteOnly,
    },
  };

  if (selection.postedWithinDays !== undefined) scope['posted_within_days'] = selection.postedWithinDays;

  const hardFilters: Record<string, unknown> = {
    countries,
    relocation: { reject_if_required: selection.rejectRelocation },
  };

  if (selection.salaryFloor > 0) {
    hardFilters['minimum_base_salary'] = { amount: selection.salaryFloor, currency: 'USD' };
  }

  return {
    scope,
    hardFilters,
    /**
     * Only what this page actually asks about.
     *
     * Emitting a field the page has no control over means resetting it on
     * every save. `direction` is edited on the Run view, and returning an
     * empty one here silently erased whatever the user had written there the
     * next time they pressed Save on this page. `require_us_payroll` and
     * `on_unknown` were the same: constants, overwriting real answers.
     */
    preferences: {
      work_arrangement: { preferred: selection.remoteOnly ? ['remote'] : ['remote', 'hybrid'] },
      application_system: { deny: selection.refuseSystems },
    },
  };
}

/** Recovers the picked options from stored config, so the portal reopens filled in. */
export function inferSelection(scope: Record<string, any>, criteria: Record<string, any>): Partial<PresetSelection> {
  const includes: string[] = scope?.titles?.include ?? [];
  const families = ROLE_FAMILIES.filter((family) =>
    family.titles.some((title) => includes.includes(title)),
  ).map((family) => family.id);

  const claimed = new Set(
    ROLE_FAMILIES.filter((family) => families.includes(family.id)).flatMap((family) => family.titles),
  );

  const excludedLevels: string[] = scope?.levels?.exclude ?? [];
  const seniority =
    excludedLevels.length === 0
      ? []
      : SENIORITY_OPTIONS.filter((option) => !option.levels.every((level) => excludedLevels.includes(level))).map(
          (option) => option.id,
        );

  const countries: string[] = scope?.locations?.countries ?? criteria?.hard_filters?.countries ?? [];
  const locations = LOCATION_OPTIONS.filter((option) =>
    option.countries.every((country) => countries.includes(country)),
  ).map((option) => option.id);

  return {
    families,
    seniority,
    locations,
    metros: scope?.locations?.metros ?? [],
    remoteOnly: Boolean(scope?.locations?.remote_only),
    postedWithinDays: scope?.posted_within_days,
    salaryFloor: criteria?.hard_filters?.minimum_base_salary?.amount ?? 0,
    refuseSystems: criteria?.preferences?.application_system?.deny ?? [],
    rejectRelocation: criteria?.hard_filters?.relocation?.reject_if_required !== false,
    screeningEnabled: criteria?.screening?.enabled !== false,
    extraTitles: includes.filter((title) => !claimed.has(title)),
    extraExcludes: (scope?.titles?.exclude ?? []).filter(
      (title: string) => !ROLE_FAMILIES.some((family) => family.excludes.includes(title)),
    ),
  };
}
