-- Stagger the four 6-hour parsers by 5 minutes each so they don't collide
-- on Groq's 12k TPM rolling window. Each parser uses ~4.3k tokens; two
-- firing in the same minute trip the limit. 5-min stagger gives a fresh
-- TPM window per parser.
UPDATE automation_recipes
SET cron_expression = '0 */6 * * *', updated_at = NOW()
WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
  AND recipe_name = 'Bank Statement Processor';

UPDATE automation_recipes
SET cron_expression = '5 */6 * * *', updated_at = NOW()
WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
  AND recipe_name = 'Credit Card Statement Processor';

UPDATE automation_recipes
SET cron_expression = '10 */6 * * *', updated_at = NOW()
WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
  AND recipe_name = 'Deduction Statement Processor';

UPDATE automation_recipes
SET cron_expression = '15 */6 * * *', updated_at = NOW()
WHERE agency_id = (SELECT id FROM public.agency ORDER BY created_at ASC LIMIT 1)
  AND recipe_name = 'Payroll Processor';
