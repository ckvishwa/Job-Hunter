-- Only safe after pasted text resumes have been removed or migrated elsewhere.
ALTER TABLE resumes DROP CONSTRAINT resumes_file_type_check;
ALTER TABLE resumes ADD CONSTRAINT resumes_file_type_check CHECK (file_type IN ('pdf', 'docx'));
