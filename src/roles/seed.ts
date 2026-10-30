import { roleDefinitionSchema, familySchema, type RoleDefinition, type RoleFamily } from "./catalog.js";

// Seed content for the editable role catalog. It is loaded into PostgreSQL by `seedCatalog` (idempotent) and is edited there
// afterwards; a person's edit is never overwritten by a newer seed. Terms are matched as whole words/phrases against APPROVED
// facts only. Cybersecurity families are primary; QA/SDET, cloud and network are secondary opportunities.
//
// Terms deliberately avoid bare ambiguous tokens (for example "soc" also matches the compliance report "SOC 2").

type Req = RoleDefinition["evidence"]["requirements"][number];
const core = (id: string, label: string, terms: string[]): Req => ({ id, label, importance: "core", terms });
const support = (id: string, label: string, terms: string[]): Req => ({ id, label, importance: "supporting", terms });

const SEED_FAMILIES: RoleFamily[] = [
  { familySlug: "soc-blue-team", name: "SOC / blue team", tier: "primary", sortOrder: 10, description: "Monitoring, triage and investigation of security alerts." },
  { familySlug: "incident-response-dfir", name: "Incident response / DFIR", tier: "primary", sortOrder: 20, description: "Containing incidents and investigating compromised systems." },
  { familySlug: "vulnerability-security-ops", name: "Vulnerability and security operations", tier: "primary", sortOrder: 30, description: "Scanning, prioritizing and tracking remediation of weaknesses." },
  { familySlug: "identity-access", name: "Identity and access management (IAM)", tier: "primary", sortOrder: 40, description: "Accounts, authentication, authorization and access lifecycle." },
  { familySlug: "grc-compliance", name: "Governance, risk and compliance (junior GRC)", tier: "primary", sortOrder: 50, description: "Entry-level control, risk and compliance work." },
  { familySlug: "qa-sdet", name: "QA / SDET", tier: "secondary", sortOrder: 110, description: "Software quality and test automation." },
  { familySlug: "cloud", name: "Cloud", tier: "secondary", sortOrder: 120, description: "Cloud operations, engineering and cloud security." },
  { familySlug: "network-noc", name: "Network / NOC", tier: "secondary", sortOrder: 130, description: "Network operations and engineering." },
];

const SEED_ROLES: RoleDefinition[] = [
  {
    roleSlug: "soc-analyst", familySlug: "soc-blue-team", title: "SOC Analyst",
    description: "Monitors security telemetry, triages alerts and escalates confirmed incidents.",
    aliases: ["SOC Analyst", "Security Operations Center Analyst", "Tier 1 SOC Analyst", "Tier 2 SOC Analyst", "Cybersecurity Analyst", "Security Monitoring Analyst", "Cyber Defense Analyst", "Threat Monitoring Analyst"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("siem", "SIEM / log monitoring", ["siem", "splunk", "qradar", "microsoft sentinel", "azure sentinel", "elastic security", "chronicle", "log analysis", "log monitoring", "security monitoring"]),
        core("alert-triage", "Alert triage and investigation", ["alert triage", "triage", "triaged alerts", "alert investigation", "security alerts", "threat monitoring", "security operations center", "soc analyst"]),
        core("endpoint-network-telemetry", "Endpoint / network detection tooling", ["edr", "crowdstrike", "defender for endpoint", "sentinelone", "carbon black", "ids ips", "snort", "suricata", "zeek", "wireshark", "packet analysis"]),
        support("threat-frameworks", "Threat frameworks", ["mitre att ck", "cyber kill chain", "threat intelligence", "ioc", "indicators of compromise"]),
        support("scripting", "Scripting / query languages", ["python", "powershell", "bash", "kql", "spl"]),
        support("certifications", "Entry security certifications", ["security+", "cysa+", "btl1", "gcih", "gsec", "sc-200"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "incident-response-analyst", familySlug: "incident-response-dfir", title: "Incident Response Analyst",
    description: "Handles security incidents from detection through containment and recovery.",
    aliases: ["Incident Response Analyst", "Incident Responder", "Cyber Incident Responder", "CSIRT Analyst", "Security Incident Analyst"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 12,
      requirements: [
        core("incident-handling", "Incident handling", ["incident response", "incident handling", "incident management", "containment", "eradication", "ir playbook", "nist 800 61", "csirt"]),
        core("detection-evidence", "Detection and log evidence", ["siem", "splunk", "edr", "crowdstrike", "log analysis", "forensic", "triage", "sentinelone"]),
        support("forensics", "Forensic tooling", ["digital forensics", "memory forensics", "volatility", "autopsy", "velociraptor", "ftk", "encase"]),
        support("malware", "Malware triage", ["malware analysis", "malware triage", "yara", "sandbox", "any run"]),
        support("certifications", "IR certifications", ["gcih", "ecih", "security+", "cysa+", "gcfe", "gcfa"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "dfir-analyst", familySlug: "incident-response-dfir", title: "DFIR Analyst",
    description: "Collects and analyzes forensic evidence from endpoints, memory and logs.",
    aliases: ["DFIR Analyst", "Digital Forensics Analyst", "Digital Forensics and Incident Response Analyst", "Forensic Analyst", "Cyber Forensic Analyst"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 12,
      requirements: [
        core("forensics", "Digital forensics", ["digital forensics", "dfir", "memory forensics", "disk forensics", "forensic imaging", "chain of custody", "volatility", "autopsy", "ftk", "encase", "velociraptor", "forensic"]),
        core("incident-handling", "Incident handling", ["incident response", "incident handling", "containment", "ir playbook"]),
        support("malware", "Malware triage", ["malware analysis", "malware triage", "yara", "sandbox"]),
        support("log-evidence", "Log and timeline analysis", ["timeline analysis", "log analysis", "windows event logs", "splunk", "elastic"]),
        support("certifications", "Forensics certifications", ["gcfe", "gcfa", "gcih", "ecih", "ccfe"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "vulnerability-analyst", familySlug: "vulnerability-security-ops", title: "Vulnerability Analyst",
    description: "Runs vulnerability scans, prioritizes findings and tracks remediation.",
    aliases: ["Vulnerability Analyst", "Vulnerability Management Analyst", "Security Operations Analyst", "Vulnerability Assessment Analyst", "Exposure Management Analyst"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("scanning", "Vulnerability scanning", ["nessus", "tenable", "qualys", "rapid7", "nexpose", "openvas", "vulnerability scanning", "vulnerability assessment", "vulnerability management"]),
        core("remediation", "Prioritization and remediation tracking", ["patch management", "remediation", "cvss", "cve", "risk prioritization", "remediation tracking", "exposure management"]),
        support("offensive-basics", "Offensive-security basics", ["burp suite", "owasp", "nmap", "metasploit", "penetration testing"]),
        support("scripting", "Scripting", ["python", "powershell", "bash"]),
        support("certifications", "Certifications", ["security+", "pnpt", "ceh", "pentest+", "cysa+"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "iam-analyst", familySlug: "identity-access", title: "IAM Analyst",
    description: "Administers identities, access requests, reviews and privileged access.",
    aliases: ["IAM Analyst", "Identity and Access Management Analyst", "Access Management Analyst", "Identity Analyst", "User Access Administrator"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("identity-platforms", "Identity platforms and protocols", ["active directory", "azure ad", "entra id", "okta", "sailpoint", "cyberark", "ping identity", "ldap", "saml", "oauth", "sso", "single sign on"]),
        core("access-lifecycle", "Access lifecycle and controls", ["access review", "access reviews", "user provisioning", "deprovisioning", "joiner mover leaver", "rbac", "role based access", "privileged access", "least privilege", "mfa", "access management"]),
        support("audit-evidence", "Audit support", ["sox", "audit evidence", "access certification", "user access review"]),
        support("scripting", "Scripting", ["powershell", "python"]),
        support("certifications", "Certifications", ["sc-300", "security+", "cisa", "ccsp"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "grc-analyst-junior", familySlug: "grc-compliance", title: "Junior GRC Analyst",
    description: "Entry-level control, risk and compliance work. Suggested only where approved facts show framework and control work.",
    aliases: ["Junior GRC Analyst", "GRC Analyst", "Compliance Analyst", "Information Security Compliance Analyst", "Risk and Compliance Analyst", "IT Risk Analyst"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("frameworks", "Security frameworks", ["nist csf", "nist 800 53", "iso 27001", "soc 2", "pci dss", "hipaa", "cis controls", "fedramp", "nist rmf"]),
        core("risk-controls", "Risk and control work", ["risk assessment", "risk register", "control testing", "control assessment", "internal audit", "policy development", "third party risk", "vendor risk"]),
        support("grc-tools", "GRC tooling", ["archer", "servicenow grc", "onetrust", "vanta", "drata"]),
        support("certifications", "Certifications", ["security+", "cisa", "iso 27001 lead", "crisc"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "sdet", familySlug: "qa-sdet", title: "SDET",
    description: "Builds automated tests and test infrastructure.",
    aliases: ["SDET", "Software Development Engineer in Test", "Test Automation Engineer", "QA Automation Engineer", "Quality Engineer", "Automation Test Engineer"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("test-automation", "Test automation frameworks", ["selenium", "playwright", "cypress", "webdriver", "appium", "test automation", "automated testing", "pytest", "junit", "testng", "rest assured"]),
        core("programming", "Programming language", ["python", "java", "javascript", "typescript", "c#"]),
        support("ci", "CI/CD", ["jenkins", "github actions", "gitlab ci", "ci cd", "azure devops"]),
        support("api-testing", "API testing", ["postman", "api testing", "rest api", "soapui"]),
        support("test-design", "Test design", ["test plan", "test cases", "regression testing", "bdd", "cucumber"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "qa-analyst", familySlug: "qa-sdet", title: "QA Analyst",
    description: "Designs and executes test cases and tracks defects.",
    aliases: ["QA Analyst", "Quality Assurance Analyst", "QA Tester", "Software Tester", "QA Engineer"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("test-design", "Test design and execution", ["test plan", "test cases", "regression testing", "manual testing", "functional testing", "uat", "user acceptance testing", "exploratory testing"]),
        core("defect-tracking", "Defect tracking", ["jira", "bug tracking", "defect tracking", "bugzilla", "defect"]),
        support("automation", "Automation exposure", ["selenium", "playwright", "cypress", "postman", "pytest"]),
        support("sql", "Data checks", ["sql", "postgresql", "mysql"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "cloud-engineer-associate", familySlug: "cloud", title: "Associate Cloud Engineer",
    description: "Operates and automates cloud infrastructure.",
    aliases: ["Associate Cloud Engineer", "Cloud Support Engineer", "Cloud Operations Engineer", "Junior Cloud Engineer", "Cloud Administrator"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("cloud-platforms", "Cloud platforms", ["aws", "azure", "gcp", "google cloud", "ec2", "s3", "lambda", "amazon web services"]),
        core("infrastructure-automation", "Infrastructure and automation", ["terraform", "cloudformation", "ansible", "kubernetes", "docker", "bicep", "infrastructure as code"]),
        support("linux", "Linux administration", ["linux", "bash"]),
        support("monitoring", "Monitoring", ["cloudwatch", "azure monitor", "datadog", "prometheus", "grafana"]),
        support("certifications", "Cloud certifications", ["aws certified", "az-900", "az-104", "ccp", "associate architect"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "cloud-security-analyst", familySlug: "cloud", title: "Cloud Security Analyst",
    description: "Monitors and hardens cloud accounts and workloads.",
    aliases: ["Cloud Security Analyst", "Cloud Security Associate", "Cloud Security Engineer"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("cloud-platforms", "Cloud platforms", ["aws", "azure", "gcp", "google cloud", "amazon web services"]),
        core("cloud-security", "Cloud security tooling", ["guardduty", "security hub", "defender for cloud", "cspm", "prisma cloud", "wiz", "cloud security", "iam policies", "cloudtrail"]),
        support("iac", "Infrastructure as code", ["terraform", "cloudformation"]),
        support("certifications", "Certifications", ["security+", "az-500", "aws security specialty", "ccsp"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "network-engineer-associate", familySlug: "network-noc", title: "Associate Network Engineer",
    description: "Configures and troubleshoots routing, switching and firewalls.",
    aliases: ["Associate Network Engineer", "Junior Network Engineer", "Network Administrator", "Network Support Engineer"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("routing-switching", "Routing and switching", ["cisco", "ccna", "ospf", "bgp", "vlan", "routing", "switching", "subnetting"]),
        core("network-tools", "Network tooling and security devices", ["wireshark", "solarwinds", "packet capture", "firewall", "palo alto", "fortinet", "cisco asa", "vpn"]),
        support("services", "Core network services", ["dns", "dhcp", "tcp ip"]),
        support("certifications", "Certifications", ["ccna", "network+", "jncia"]),
      ],
    },
    active: true,
  },
  {
    roleSlug: "noc-technician", familySlug: "network-noc", title: "NOC Technician",
    description: "Watches network health and escalates incidents.",
    aliases: ["NOC Technician", "Network Operations Center Technician", "NOC Analyst", "Network Monitoring Technician"],
    evidence: {
      minCoreMatches: 2, advisoryProfessionalMonths: 0,
      requirements: [
        core("monitoring", "Network monitoring", ["noc", "network operations center", "network monitoring", "solarwinds", "nagios", "prtg", "zabbix", "incident escalation"]),
        core("network-fundamentals", "Network fundamentals", ["tcp ip", "dns", "dhcp", "vlan", "ccna", "network troubleshooting", "routing", "switching"]),
        support("ticketing", "Ticketing", ["servicenow", "jira service management", "ticketing", "remedy"]),
        support("certifications", "Certifications", ["network+", "ccna"]),
      ],
    },
    active: true,
  },
];

export const SEED_CATALOG: { families: RoleFamily[]; roles: RoleDefinition[] } = {
  families: SEED_FAMILIES.map((f) => familySchema.parse(f)),
  roles: SEED_ROLES.map((r) => roleDefinitionSchema.parse(r)),
};
