-- DEMO PROJECT ONLY. Fictional facility stock, not verified physical availability.
begin;
do $$
declare
  v_clinic uuid := '7da05698-b748-4e79-b99e-3abcbdcb1001';
  v_supplier uuid := '7da05698-b748-4e79-b99e-3abcbdcb1002';
  v_clinic_user uuid;
  v_supplier_user uuid;
  v_para uuid := '9ee2a001-c270-4eca-8c10-f7df1c110001';
  v_amox uuid := '9ee2a001-c270-4eca-8c10-f7df1c110002';
  v_a uuid := '3abc3a01-d490-4dc3-b700-000000000001';
  v_b uuid := '3abc3a01-d490-4dc3-b700-000000000002';
  v_c uuid := '3abc3a01-d490-4dc3-b700-000000000003';
  v_d uuid := '3abc3a01-d490-4dc3-b700-000000000004';
begin
  select p.id into v_clinic_user from public.profiles p join auth.users u on u.id=p.id where p.facility_id=v_clinic and lower(u.email)='clinic@medinexus.example';
  select p.id into v_supplier_user from public.profiles p join auth.users u on u.id=p.id where p.facility_id=v_supplier and lower(u.email)='supplier@medinexus.example';
  if v_clinic_user is null or v_supplier_user is null then raise exception 'Demo facility accounts are required'; end if;
  insert into public.medicines (id,name,generic_name,active_ingredient,strength,dosage_form,unit_of_measure) values
    (v_para,'Paracetamol','Paracetamol','Paracetamol','500 mg','tablet','tablet'),
    (v_amox,'Amoxicillin','Amoxicillin','Amoxicillin','250 mg','capsule','capsule');
  insert into public.inventory_batches (id,facility_id,medicine_id,batch_number,quantity_on_hand,low_stock_threshold,expiry_date,last_updated_at) values
    (v_a,v_clinic,v_para,'DEMO-CL-P01',20,30,current_date+300,now()),
    (v_b,v_clinic,v_amox,'DEMO-CL-A01',18,10,current_date+20,now()),
    (v_c,v_supplier,v_para,'DEMO-PH-P01',140,25,current_date+365,now()),
    (v_d,v_supplier,v_amox,'DEMO-PH-A01',80,10,current_date+250,now()-interval '10 days');
  insert into public.stock_movements (facility_id,inventory_batch_id,medicine_id,movement_type,quantity,performed_by,notes) values
    (v_clinic,v_a,v_para,'INITIAL_STOCK',20,v_clinic_user,'Fictional demo seed'),
    (v_clinic,v_b,v_amox,'INITIAL_STOCK',18,v_clinic_user,'Fictional demo seed'),
    (v_supplier,v_c,v_para,'INITIAL_STOCK',140,v_supplier_user,'Fictional demo seed'),
    (v_supplier,v_d,v_amox,'INITIAL_STOCK',80,v_supplier_user,'Fictional demo seed');
end;
$$;
commit;
