-- 009_any_email.sql
-- Any valid personal e-mail address (Gmail, Outlook, college, ...) can now register.
-- The college-domain rule is removed from the student trigger; the e-mail FORMAT is still checked
-- by the CHECK constraint on student.email, and the address must still be VERIFIED by e-mail link.
-- Table college_email_domain is kept (unused) so older scripts and the ER diagram keep working.
CREATE OR REPLACE FUNCTION validate_student() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
DECLARE
    v_campus INTEGER;
BEGIN
    SELECT campus_id INTO v_campus FROM department WHERE department_id = NEW.department_id;
    IF v_campus IS NULL THEN
        RAISE EXCEPTION 'Unknown department' USING ERRCODE = 'check_violation';
    END IF;
    NEW.campus_id := v_campus;

    -- a changed e-mail has to be verified again
    IF TG_OP = 'UPDATE' AND NEW.email IS DISTINCT FROM OLD.email THEN
        NEW.email_verified := false;
        NEW.email_verified_at := NULL;
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.semester < OLD.semester THEN
            RAISE EXCEPTION 'The semester cannot go backwards' USING ERRCODE = 'check_violation';
        END IF;
        IF NEW.department_id <> OLD.department_id AND OLD.semester > 2 THEN
            RAISE EXCEPTION 'The department can only be changed in the first year (semesters 1 and 2)' USING ERRCODE = 'check_violation';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
