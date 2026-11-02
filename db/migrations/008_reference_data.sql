-- 008_reference_data.sql
-- Fixed reference data (idempotent).
--   * two campuses (the registration form asks: Campus, then Department)
--   * the six B.Tech departments exist on every campus (B.Tech is the only programme: CHECK ck_student_program)
--   * the college e-mail domain(s) accepted at registration
-- ADJUST the campuses and college_email_domain to your college. Sub-domains are accepted:
-- 'pes.edu' also accepts 'pesu.pes.edu'. Add rows later with:  npm run college:domain -- add your-college.edu

INSERT INTO campus (name, city) VALUES ('RR Campus', 'Bengaluru'), ('EC Campus', 'Bengaluru') ON CONFLICT (name) DO NOTHING;

INSERT INTO department (campus_id, name)
SELECT c.campus_id, d.name
FROM campus c
CROSS JOIN (VALUES ('CSE'), ('CSE (AI & ML)'), ('Biotechnology'), ('ECE'), ('EEE'), ('Mechanical')) AS d(name)
WHERE c.name IN ('RR Campus', 'EC Campus')
ON CONFLICT (campus_id, name) DO NOTHING;

INSERT INTO college_email_domain (domain) VALUES ('pes.edu') ON CONFLICT DO NOTHING;
