-- Add pasted UTF-8 resume text to the existing private resume/fact lifecycle.
-- 0012 avoids the migration numbers already used on the M0 baseline PR.
ALTER TABLE resumes DROP CONSTRAINT resumes_file_type_check;
ALTER TABLE resumes ADD CONSTRAINT resumes_file_type_check CHECK (file_type IN ('pdf', 'docx', 'text'));
